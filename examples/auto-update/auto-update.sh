#!/usr/bin/env bash
# Sendo と sendo-reader を、上流の main に自動で追いつかせる例（docs/decisions/container.md の 13）。
# compose.yaml と同じ場所に置き、cron などから 1 時間おきくらいに動かす。使い方は README.md。
#
#   ./auto-update.sh           上げてよければ上げる
#   ./auto-update.sh --check   何をするかを出すだけで、何も変えない
#
# 決まりごと
# - 上げるのは、ghcr.io/sendo-feed/sendo と ghcr.io/sendo-feed/sendo-reader のイメージを main のタグで
#   指定したサービスだけ。sha-<コミット> のタグかダイジェストで固定すると、どちらも上げない
# - 上げてよいのは、イメージが上流の main の最新のコミットのもので、そのコミットの CI が通っているときだけ。
#   片方を上げられないときは、もう片方も上げない
# - sendo を上げるときは、sendo-reader を止め、sendo を止めてからバックアップを取り、新しい sendo が
#   healthy になってから sendo-reader を起こす。healthy にならなければ、前のイメージとバックアップを
#   組で戻し、その版を飛ばす
# - 途中で失敗したら、その回のうちに、書き留めた段（.auto-update/journal）から戻す。実行ごと落ちたら、
#   次の実行が戻す
# - この例を使うときは、手で docker compose pull しない。動いている間は compose を操作しない
set -euo pipefail

cd "$(dirname "$0")"
here=$(pwd)

if [[ -f auto-update.env ]]; then
  # shellcheck source=/dev/null
  . ./auto-update.env
fi

STATE_DIR=${STATE_DIR:-.auto-update}
BACKUP_DIR=${BACKUP_DIR:-backups}
HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-600}
NOTIFY_URL=${NOTIFY_URL:-}
NOTIFY_FORMAT=${NOTIFY_FORMAT:-text}
GITHUB_TOKEN=${GITHUB_TOKEN:-}

SENDO_IMAGE=ghcr.io/sendo-feed/sendo
READER_IMAGE=ghcr.io/sendo-feed/sendo-reader
SENDO_REPO=sendo-feed/sendo
READER_REPO=sendo-feed/sendo-reader
# 戻す先の前のイメージに付けておくタグ（docker image prune で消されないように）
PREV_TAG=auto-update-prev
# 同じ回の戻しを、何回までやり直すか。超えたら止まったとして、手に任せる
MAX_ATTEMPTS=3

check_only=false
case ${1:-} in
"") ;;
--check) check_only=true ;;
-h | --help)
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
  ;;
*)
  echo "auto-update.sh: 知らない指定：$1" >&2
  exit 2
  ;;
esac

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

die() {
  echo "auto-update.sh: $*" >&2
  exit 1
}

# 設定の間違いで、止めたあとに抜けないよう、何かを変える前に確かめる
[[ $HEALTH_TIMEOUT_SECONDS =~ ^[1-9][0-9]*$ ]] ||
  die "HEALTH_TIMEOUT_SECONDS は 1 以上の整数（秒）で書く：$HEALTH_TIMEOUT_SECONDS"
case $NOTIFY_FORMAT in
text | discord | slack) ;;
*) die "NOTIFY_FORMAT は text、discord、slack のどれか：$NOTIFY_FORMAT" ;;
esac

for tool in docker jq curl flock realpath; do
  command -v "$tool" >/dev/null || die "$tool が要る"
done

journal=$STATE_DIR/journal

# 知らせは、NOTIFY_URL を設定したときだけ送る。「上げなかった」が同じ理由で続くときは、2 回目から
# 送らない（数字は比べない）。送れなくても、更新は止めない。URL は引数に出さない（ps に見える）
notify() {
  local text="[sendo auto-update] $*" key=
  log "$*"
  [[ -n $NOTIFY_URL ]] || return 0
  if [[ $* == 上げなかった：* ]]; then
    key=$(tr -d '0-9' <<<"$*")
    [[ $(cat "$STATE_DIR/last-notify" 2>/dev/null) != "$key" ]] || return 0
  fi
  local body type=application/json
  case $NOTIFY_FORMAT in
  discord) body=$(jq -n --arg t "$text" '{content: $t}') ;;
  slack) body=$(jq -n --arg t "$text" '{text: $t}') ;;
  *)
    body=$text
    type='text/plain; charset=utf-8'
    ;;
  esac
  if curl -fsS -m 30 -K <(printf 'url = "%s"\n' "$NOTIFY_URL") -X POST -H "Content-Type: $type" \
    --data-binary @- <<<"$body" >/dev/null; then
    printf '%s' "$key" >"$STATE_DIR/last-notify" 2>/dev/null || true
  else
    log "知らせを送れなかった"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# compose と Docker

compose() {
  docker compose "$@"
}

# compose.yaml で、指定したイメージを使うサービスの「名前 イメージ」
find_service() {
  compose config --format json |
    jq -r --arg r "$1" '
      .services | to_entries[]
      | select(.value.image != null)
      | select(.value.image | startswith($r + ":") or startswith($r + "@") or . == $r)
      | "\(.key) \(.value.image)"' |
    awk 'NR == 1'
}

# sendo に、sendo-reader を通らない入口（ポートやホストのネットワーク）があるか
has_direct_entry() {
  compose config --format json |
    jq -e --arg s "$1" '.services[$s] | ((.ports // []) | length > 0) or .network_mode == "host"' >/dev/null
}

running_cid() {
  compose ps -q --status running "$1" | awk 'NR == 1'
}

any_cid() {
  compose ps -aq "$1" 2>/dev/null | awk 'NR == 1'
}

image_of_container() {
  docker inspect -f '{{.Image}}' "$1"
}

revision_of_image() {
  docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null || true
}

# 作り直すときに、compose が上流から取り直さないように（pull_policy を書いていても）
up() {
  compose up -d --pull never --no-deps "$1"
}

health_of() {
  local cid
  cid=$(any_cid "$1")
  [[ -n $cid ]] || {
    echo missing
    return 0
  }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo missing
}

# healthy になるまで、HEALTH_TIMEOUT_SECONDS まで待つ
wait_healthy() {
  local service=$1 deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS)) status
  while :; do
    status=$(health_of "$service")
    [[ $status == healthy ]] && return 0
    ((SECONDS < deadline)) || break
    # 上限を過ぎて眠らない（最後の確かめは、上限のときにする）
    sleep $((deadline - SECONDS < 5 ? deadline - SECONDS : 5))
  done
  log "$service が ${HEALTH_TIMEOUT_SECONDS} 秒のうちに healthy にならなかった（$status）"
  return 1
}

# ---------------------------------------------------------------------------
# 上流（GitHub と GHCR）

# トークンは引数に出さない（ps に見える）
github() {
  if [[ -n $GITHUB_TOKEN ]]; then
    curl -fsS -m 30 -H @<(printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN") -H 'X-GitHub-Api-Version: 2022-11-28' "$@"
  else
    curl -fsS -m 30 -H 'X-GitHub-Api-Version: 2022-11-28' "$@"
  fi
}

latest_commit() {
  github -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$1/commits/main"
}

# そのコミットで、main への push で動いた CI のワークフロー（ci.yml）が通ったか
ci_passed() {
  github -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$1/actions/workflows/ci.yml/runs?head_sha=$2&event=push&per_page=1" |
    jq -e '.workflow_runs[0] | .status == "completed" and .conclusion == "success"' >/dev/null
}

# GHCR の main のタグのイメージが、どのコミットから作られたか（取ってこずに、ラベルを読む）
remote_revision() {
  local repo=${1#ghcr.io/} arch token manifest digest config
  arch=$(docker version -f '{{.Server.Arch}}')
  token=$(curl -fsS -m 30 "https://ghcr.io/token?scope=repository:$repo:pull" | jq -r .token)
  local accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
  manifest=$(curl -fsS -m 30 -H "Authorization: Bearer $token" -H "Accept: $accept" "https://ghcr.io/v2/$repo/manifests/main")
  if jq -e '.manifests' >/dev/null <<<"$manifest"; then
    digest=$(jq -r --arg a "$arch" '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $a)][0].digest // empty' <<<"$manifest")
    [[ -n $digest ]] || return 1
    manifest=$(curl -fsS -m 30 -H "Authorization: Bearer $token" -H "Accept: $accept" "https://ghcr.io/v2/$repo/manifests/$digest")
  fi
  config=$(jq -r .config.digest <<<"$manifest")
  curl -fsSL -m 60 -H "Authorization: Bearer $token" "https://ghcr.io/v2/$repo/blobs/$config" |
    jq -r '.config.Labels["org.opencontainers.image.revision"] // empty'
}

# ---------------------------------------------------------------------------
# 書き留め（途中で失敗・中断したときに、書き留めた段から戻すため）

ATTEMPTS=0

save_journal() {
  local tmp=$journal.tmp
  {
    printf 'STAGE=%q\nATTEMPTS=%q\n' "$1" "$ATTEMPTS"
    printf 'SENDO_SERVICE=%q\nREADER_SERVICE=%q\n' "$SENDO_SERVICE" "$READER_SERVICE"
    printf 'PREV_SENDO_IMAGE=%q\nPREV_READER_IMAGE=%q\n' "$PREV_SENDO_IMAGE" "$PREV_READER_IMAGE"
    printf 'NEW_SENDO_REV=%q\nNEW_READER_REV=%q\n' "$NEW_SENDO_REV" "$NEW_READER_REV"
    printf 'DATA_SRC=%q\nBACKUP_FILE=%q\n' "$DATA_SRC" "$BACKUP_FILE"
  } >"$tmp"
  mv "$tmp" "$journal"
}

# 段の名前は英小文字と _ だけなので、そのまま読める
journal_stage() {
  sed -n 's/^STAGE=//p' "$journal"
}

# 回を終える：書き留めを消し、前のイメージに付けたタグを外す（使われていなければ、イメージも消える）
clear_journal() {
  rm -f "$journal"
  docker image rm "$SENDO_IMAGE:$PREV_TAG" "$READER_IMAGE:$PREV_TAG" >/dev/null 2>&1 || true
}

stuck() {
  save_journal stuck
  notify "止まった：$*。手での直し方は README の「止まったとき」"
  exit 1
}

# 手元の main のタグを、前のイメージ（動いていたもの）に戻す。次にコンテナを作り直したとき、
# 確かめていない版が動かないように
restore_tags() {
  docker tag "$PREV_SENDO_IMAGE" "$SENDO_IMAGE:main"
  docker tag "$PREV_READER_IMAGE" "$READER_IMAGE:main"
}

skip_revision() {
  printf '%s\n' "$2" >"$STATE_DIR/skip-$1"
}

skipped_revision() {
  cat "$STATE_DIR/skip-$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 上げる、戻す

# sendo-reader を起こす（上げるなら、手元の main のタグはもう新しい版）。結果は READER_RESULT に入れる
#   ok（healthy になった）／ rolled_back（新しい版を戻した）／ unhealthy
start_reader() {
  up "$READER_SERVICE"
  if wait_healthy "$READER_SERVICE"; then
    READER_RESULT=ok
    return 0
  fi
  if [[ -z $NEW_READER_REV ]]; then
    READER_RESULT=unhealthy
    notify "止まった：sendo-reader が healthy にならない（上げていない版）。docker compose logs で確かめる"
    return 0
  fi
  save_journal reader_rolling_back
  rollback_reader
}

# 新しい sendo-reader を、前のイメージに戻して、その版を飛ばす
rollback_reader() {
  local rev=$NEW_READER_REV
  docker tag "$PREV_READER_IMAGE" "$READER_IMAGE:main"
  up "$READER_SERVICE"
  skip_revision reader "$rev"
  if wait_healthy "$READER_SERVICE"; then
    READER_RESULT=rolled_back
    notify "戻した：sendo-reader ${rev:0:7} が healthy にならないので、前のイメージに戻した。上流の main に次のコミットが入るまで上げない"
  else
    READER_RESULT=unhealthy
    notify "止まった：sendo-reader を前のイメージに戻しても healthy にならない。docker compose logs で確かめる"
  fi
  # 知らせたあとで段を進める（それまでに落ちたら、この戻しをやり直す。何度やっても同じ結果になる）
  NEW_READER_REV=
  save_journal sendo_healthy
}

# sendo-reader が起きているか。分からなければ（docker が答えない）、戻さずに抜けて、やり直しに任せる
reader_is_running() {
  local cid
  cid=$(running_cid "$READER_SERVICE") || {
    log "sendo-reader が起きているかを確かめられない（docker が答えない）"
    exit 1
  }
  [[ -n $cid ]]
}

# sendo が healthy にならないとき：前のイメージと、上げる直前のバックアップを組で戻す。
# 何度やっても同じ結果になるので、途中で落ちたら、この段からやり直せばよい
rollback_sendo() {
  save_journal rolling_back
  # sendo-reader を新しい sendo で起こしたあとに戻すと、端末が進めた同期の番号より前に戻る
  if reader_is_running; then
    stuck "sendo を戻す前に sendo-reader が起きていたので、戻していない（同期の番号が食い違うため）"
  fi
  [[ -f $BACKUP_FILE ]] || stuck "sendo を戻すバックアップ（$BACKUP_FILE）がない"
  compose stop "$SENDO_SERVICE"
  compose rm -f "$SENDO_SERVICE"
  ./backup.sh --service "$SENDO_SERVICE" --data "$DATA_SRC" --image "$PREV_SENDO_IMAGE" restore "$BACKUP_FILE"
  restore_tags
  up "$SENDO_SERVICE"
  skip_revision sendo "$NEW_SENDO_REV"
  wait_healthy "$SENDO_SERVICE" ||
    stuck "sendo を前のイメージとバックアップに戻しても healthy にならない。sendo-reader は止めたまま"
  NEW_READER_REV=
  save_journal rolled_back
  after_rolled_back
}

# sendo を戻し終えたあと：sendo-reader を（上げずに）起こして終わる
after_rolled_back() {
  start_reader
  clear_journal
  notify "戻した：sendo ${NEW_SENDO_REV:0:7} が healthy にならないので、前のイメージと上げる直前のバックアップに戻した。上流の main に次のコミットが入るまで上げない"
}

# 新しい sendo で起動したあと：healthy を待ち、だめなら戻す。よければ sendo-reader を起こして終わる
after_sendo_started() {
  if ! wait_healthy "$SENDO_SERVICE"; then
    rollback_sendo
    return 0
  fi
  save_journal sendo_healthy
  finish
}

# sendo は動いている（上げたか、上げる版がなかった）。sendo-reader を起こすか上げて終わる
finish() {
  READER_RESULT=
  start_reader
  finalize
}

finalize() {
  local done=()
  [[ -z $NEW_SENDO_REV ]] || done+=("sendo を ${NEW_SENDO_REV:0:7} に")
  [[ -z $NEW_READER_REV || $READER_RESULT != ok ]] || done+=("sendo-reader を ${NEW_READER_REV:0:7} に")
  clear_journal
  ((${#done[@]} == 0)) || notify "上げた：${done[*]}"
}

# 新しい版で起動する前の段で失敗・中断したとき：前のイメージのまま起こし直す
recover_before_start() {
  restore_tags
  [[ -z $BACKUP_FILE ]] || rm -f "$BACKUP_FILE.partial"
  up "$SENDO_SERVICE"
  wait_healthy "$SENDO_SERVICE" || stuck "前のイメージで起こし直した sendo が healthy にならない"
  NEW_SENDO_REV=
  NEW_READER_REV=
  start_reader
  clear_journal
  notify "上げなかった：sendo を上げる前の段で失敗・中断したので、前のイメージのまま起こし直した"
}

# 書き留めた段から戻して、この回は終わる
resume() {
  local STAGE
  # shellcheck source=/dev/null
  . "$journal"
  [[ $STAGE != stuck ]] || {
    log "止まったままになっている。README の「止まったとき」のとおりに直し、$journal を消す"
    exit 1
  }
  ATTEMPTS=$((ATTEMPTS + 1))
  ((ATTEMPTS <= MAX_ATTEMPTS)) || stuck "段「$STAGE」から戻すのに ${MAX_ATTEMPTS} 回失敗した"
  save_journal "$STAGE" || {
    notify "止まった：書き留め（$journal）を書けない（ディスクがいっぱい？）。段「$STAGE」のまま"
    exit 1
  }
  log "段「$STAGE」から戻す（${ATTEMPTS} 回目）"
  case $STAGE in
  pulled)
    restore_tags
    clear_journal
    ;;
  stopping | backing_up) recover_before_start ;;
  sendo_started)
    # sendo のコンテナが前のイメージのまま（新しい版で起こす前に落ちた）なら、前のイメージで起こし直す。
    # それ以外（新しい版か、分からない）は、新しい版がマイグレーションを当てたかもしれないので、
    # 新しい版で起こし直して healthy を待ち、だめならバックアップと組で戻す（バックアップは取り終え、
    # sendo-reader も止めてある）
    local cid image=
    cid=$(any_cid "$SENDO_SERVICE")
    [[ -z $cid ]] || image=$(image_of_container "$cid" 2>/dev/null || true)
    if [[ -n $image && $image == "$PREV_SENDO_IMAGE" ]]; then
      recover_before_start
    else
      up "$SENDO_SERVICE"
      after_sendo_started
    fi
    ;;
  sendo_healthy) finish ;;
  reader_rolling_back)
    rollback_reader
    finalize
    ;;
  rolling_back) rollback_sendo ;;
  rolled_back) after_rolled_back ;;
  *) stuck "知らない段「$STAGE」" ;;
  esac
  return 0
}

# 途中で失敗して抜けるとき（set -e）：その回のうちに、書き留めた段から戻す
# （trap の中では、引数のない return が trap の前の終了コードを返すので、どの関数も return 0 と書く）
on_exit() {
  local rc=$? rc2
  trap - EXIT
  if ((rc != 0)) && [[ -f $journal && $(journal_stage) != stuck ]]; then
    log "途中で失敗した（終了コード $rc）。この回のうちに戻す"
    # 戻すのにも失敗したら、止まったままのことがあるので、知らせてから抜ける（次の実行がやり直す）。
    # trap の中で張った trap は動かないので、サブシェルで動かし、終了コードを見る
    set +e
    (
      set -e
      resume
    )
    rc2=$?
    set -e
    if ((rc2 != 0)) && [[ -f $journal && $(journal_stage) != stuck ]]; then
      notify "止まった：途中の失敗から戻すのにも失敗した（段「$(journal_stage)」）。次の実行でやり直す。続くときは README の「止まったとき」"
    fi
  fi
  exit "$rc"
}

# ---------------------------------------------------------------------------
# どうするかを決める

# 1 つのサービスを確かめ、「状態、上流の最新のコミット、CI が通ったか、理由」を
# 区切り文字（\x1f。空の欄が詰まらないよう、空白でないもの）でつないで出す。
# 状態は current（最新）／ upgrade（上げてよい）／ block（上げられない）
#   $1: 名前（sendo か reader）、$2: compose に書いたイメージ、$3: リポジトリ、$4: 動いているコミット、$5: イメージ
evaluate() {
  local name=$1 configured=$2 repo=$3 running=$4 image=$5 latest='' remote ci=false
  out() { printf '%s\x1f%s\x1f%s\x1f%s\n' "$1" "$latest" "$ci" "$2"; }
  if [[ $configured != "$image:main" ]]; then
    out block "main のタグではない（$configured）ので固定と見る"
    return 0
  fi
  if ! latest=$(latest_commit "$repo"); then
    latest=
    out block "上流の main の最新のコミットを取れない"
    return 0
  fi
  if ci_passed "$repo" "$latest"; then ci=true; fi
  if [[ $running == "$latest" ]]; then
    out current "動いているのが上流の main の最新（${latest:0:7}）"
    return 0
  fi
  if ! remote=$(remote_revision "$image") || [[ -z $remote ]]; then
    out block "GHCR の main のイメージを読めない"
    return 0
  fi
  if [[ $remote != "$latest" ]]; then
    out block "上流の main の最新（${latest:0:7}）のイメージがまだない（GHCR の main は ${remote:0:7}）"
    return 0
  fi
  if [[ $ci != true ]]; then
    out block "上流の main の最新（${latest:0:7}）の CI が、まだ終わっていないか、落ちた"
    return 0
  fi
  if [[ $(skipped_revision "$name") == "$latest" ]]; then
    out block "${latest:0:7} は前に戻した版なので、上流の main に次のコミットが入るまで上げない"
    return 0
  fi
  out upgrade "${running:0:7} → ${latest:0:7}"
}

main() {
  if [[ -f $journal ]]; then
    if $check_only; then
      if [[ $(journal_stage) == stuck ]]; then
        log "止まったままになっている（$journal）。README の「止まったとき」のとおりに直す"
      else
        log "前の実行の書き留め（$journal）が残っている。次の実行は、まずその段から戻す"
      fi
      exit 0
    fi
    resume
    exit 0
  fi

  local sendo_line reader_line
  sendo_line=$(find_service "$SENDO_IMAGE")
  reader_line=$(find_service "$READER_IMAGE")
  [[ -n $sendo_line ]] || die "compose.yaml に $SENDO_IMAGE のサービスがない"
  [[ -n $reader_line ]] ||
    die "compose.yaml に $READER_IMAGE のサービスがない。この例は、sendo と sendo-reader を並べた構成だけで使う"
  SENDO_SERVICE=${sendo_line%% *}
  READER_SERVICE=${reader_line%% *}
  local sendo_configured=${sendo_line#* } reader_configured=${reader_line#* }

  # healthy になる前の新しい sendo に、sendo-reader を通らずに要求が届く構成では使わない（戻すと同期の番号が食い違う）
  ! has_direct_entry "$SENDO_SERVICE" ||
    die "$SENDO_SERVICE にポート（か host のネットワーク）がある。この例は、sendo のポートを出さない構成だけで使う"

  # 始めるときに止まっているサービスは、使う人が止めたのかもしれないので、何も変えない
  local sendo_cid reader_cid
  sendo_cid=$(running_cid "$SENDO_SERVICE")
  reader_cid=$(running_cid "$READER_SERVICE")
  if [[ -z $sendo_cid || -z $reader_cid ]]; then
    log "$SENDO_SERVICE か $READER_SERVICE が動いていないので、何も変えない"
    exit 0
  fi

  PREV_SENDO_IMAGE=$(image_of_container "$sendo_cid")
  PREV_READER_IMAGE=$(image_of_container "$reader_cid")
  local sendo_running reader_running
  sendo_running=$(revision_of_image "$PREV_SENDO_IMAGE")
  reader_running=$(revision_of_image "$PREV_READER_IMAGE")

  DATA_SRC=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$sendo_cid")
  if [[ -z $DATA_SRC || $DATA_SRC =~ ^[0-9a-f]{64}$ ]]; then
    die "$SENDO_SERVICE の /data が、名前付きのボリュームでもバインドマウントでもない。消して戻すとデータを失うので、上げない"
  fi

  local sendo_state sendo_reason sendo_target sendo_ci reader_state reader_reason reader_target
  IFS=$'\x1f' read -r sendo_state sendo_target sendo_ci sendo_reason \
    < <(evaluate sendo "$sendo_configured" "$SENDO_REPO" "$sendo_running" "$SENDO_IMAGE")
  IFS=$'\x1f' read -r reader_state reader_target _ reader_reason \
    < <(evaluate reader "$reader_configured" "$READER_REPO" "$reader_running" "$READER_IMAGE")

  # sendo-reader の新しい版は、上流の最新で CI の通った sendo の上でだけ動かす
  if [[ $reader_state == upgrade && $sendo_state == current && $sendo_ci != true ]]; then
    reader_state=block
    reader_reason="動いている sendo（${sendo_running:0:7}）の CI が通っていない"
  fi

  echo "sendo（$SENDO_SERVICE）：$sendo_state：$sendo_reason"
  echo "sendo-reader（$READER_SERVICE）：$reader_state：$reader_reason"

  if [[ $sendo_state == block || $reader_state == block ]]; then
    log "上げられないものがあるので、どちらも上げない"
    exit 0
  fi
  if [[ $sendo_state == current && $reader_state == current ]]; then
    log "どちらも最新なので、何も変えない"
    exit 0
  fi

  NEW_SENDO_REV=
  NEW_READER_REV=
  [[ $sendo_state != upgrade ]] || NEW_SENDO_REV=$sendo_target
  [[ $reader_state != upgrade ]] || NEW_READER_REV=$reader_target
  BACKUP_FILE=
  if [[ -n $NEW_SENDO_REV ]]; then
    # backup.sh が docker run で付けるので、絶対パスにする（--check では、ディレクトリを作らない）
    BACKUP_FILE=$(realpath -m "$BACKUP_DIR")/sendo-data.tar
    # /data の中に置くと、戻すときに中身を消すので、バックアップごと消える
    if [[ $DATA_SRC == /* ]]; then
      case $BACKUP_FILE/ in
      "$(realpath -m "$DATA_SRC")"/*) die "BACKUP_DIR（$BACKUP_DIR）が sendo の /data（$DATA_SRC）の中にある。外に置く" ;;
      esac
    fi
  fi

  if $check_only; then
    echo "することの順番："
    if [[ -n $NEW_SENDO_REV ]]; then
      echo "  1. sendo と（上げるなら）sendo-reader のイメージを取り、バックアップを置く場所（$BACKUP_FILE）の空きを確かめる"
      echo "  2. sendo-reader を止め、sendo を止めて、/data（$DATA_SRC）をバックアップする"
      echo "  3. sendo を ${NEW_SENDO_REV:0:7} で起こし、healthy を待つ（上限 ${HEALTH_TIMEOUT_SECONDS} 秒）。ならなければ、前のイメージとバックアップに戻す"
      if [[ -n $NEW_READER_REV ]]; then
        echo "  4. sendo が healthy になってから、sendo-reader を ${NEW_READER_REV:0:7} で起こす"
      else
        echo "  4. sendo が healthy になってから、sendo-reader を今のイメージのまま起こす（上げる版がない）"
      fi
    else
      echo "  1. sendo には触らず、sendo-reader を ${NEW_READER_REV:0:7} に上げる"
    fi
    echo "（--check なので、何も変えていない）"
    exit 0
  fi

  # ここから先で失敗したら、その回のうちに戻す
  trap on_exit EXIT

  # イメージを取る前に書き留め、前のイメージにタグを付ける（取ると手元の main のタグが進むので、戻す先を残す）
  docker tag "$PREV_SENDO_IMAGE" "$SENDO_IMAGE:$PREV_TAG"
  docker tag "$PREV_READER_IMAGE" "$READER_IMAGE:$PREV_TAG"
  save_journal pulled
  # 手元の main のタグを、動いているイメージにそろえてから、上げるものだけを取る
  restore_tags
  local pull=()
  [[ -z $NEW_SENDO_REV ]] || pull+=("$SENDO_SERVICE")
  [[ -z $NEW_READER_REV ]] || pull+=("$READER_SERVICE")
  compose pull -q "${pull[@]}"
  # 確かめたあとに上流が進んで、別の版を取っていたら上げない
  if [[ -n $NEW_SENDO_REV && $(revision_of_image "$SENDO_IMAGE:main") != "$NEW_SENDO_REV" ]] ||
    [[ -n $NEW_READER_REV && $(revision_of_image "$READER_IMAGE:main") != "$NEW_READER_REV" ]]; then
    restore_tags
    clear_journal
    log "取ったイメージが、確かめた版と違う（上流が進んだ）。次の回に回す"
    exit 0
  fi

  if [[ -z $NEW_SENDO_REV ]]; then
    # sendo には触らず、sendo-reader だけを上げる
    save_journal sendo_healthy
    finish
    exit 0
  fi

  # バックアップを置けるか（書けるか、空きが足りるか）を、止める前に確かめる。
  # 前のバックアップは、新しいものを取る前に消すので、その分も空きに足す
  local need free old=0
  if ! { mkdir -p "$BACKUP_DIR" && : >"$BACKUP_FILE.write-test" && rm -f "$BACKUP_FILE.write-test"; } 2>/dev/null; then
    restore_tags
    clear_journal
    notify "上げなかった：バックアップを置く場所（$BACKUP_DIR）に書けない"
    exit 1
  fi
  need=$(./backup.sh --service "$SENDO_SERVICE" --data "$DATA_SRC" --image "$PREV_SENDO_IMAGE" size)
  free=$(df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')
  [[ ! -f $BACKUP_FILE ]] || old=$(($(stat -c %s "$BACKUP_FILE") / 1024))
  if ((free + old < need + need / 10 + 1024)); then
    restore_tags
    clear_journal
    notify "上げなかった：バックアップを置く空きが足りない（要るのは約 $((need / 1024)) MiB、空きは約 $(((free + old) / 1024)) MiB。$BACKUP_DIR）"
    exit 1
  fi
  save_journal stopping
  compose stop "$READER_SERVICE"
  compose stop "$SENDO_SERVICE"

  save_journal backing_up
  rm -f "$BACKUP_FILE"
  ./backup.sh --service "$SENDO_SERVICE" --data "$DATA_SRC" --image "$PREV_SENDO_IMAGE" create "$BACKUP_FILE" >/dev/null

  save_journal sendo_started
  up "$SENDO_SERVICE"
  after_sendo_started
}

if $check_only; then
  main
else
  mkdir -p "$STATE_DIR"
  # 1 回ずつ動かす。ロックはプロセスが終われば外れるので、落ちた実行の印は残らない
  exec 9>"$STATE_DIR/lock"
  if ! flock -n 9; then
    log "前の実行が終わっていないので、何もしない"
    exit 0
  fi
  main
fi
log "終わった（$here）"
