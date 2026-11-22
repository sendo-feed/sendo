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
# - 実行が途中で落ちても、次の実行が、書き留めた段から続きを戻す（.auto-update/journal）
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

check_only=false
case ${1:-} in
"") ;;
--check) check_only=true ;;
-h | --help)
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
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

# 知らせは、NOTIFY_URL を設定したときだけ送る。送れなくても、更新は止めない
notify() {
  local text="[sendo auto-update] $*"
  log "$*"
  [[ -n $NOTIFY_URL ]] || return 0
  local body type=application/json
  case $NOTIFY_FORMAT in
  discord) body=$(jq -n --arg t "$text" '{content: $t}') ;;
  slack) body=$(jq -n --arg t "$text" '{text: $t}') ;;
  *)
    body=$text
    type='text/plain; charset=utf-8'
    ;;
  esac
  curl -fsS -m 30 -X POST -H "Content-Type: $type" --data-binary "$body" "$NOTIFY_URL" >/dev/null ||
    log "知らせを送れなかった"
}

for tool in docker jq curl flock; do
  command -v "$tool" >/dev/null || {
    echo "auto-update.sh: $tool が要る" >&2
    exit 1
  }
done

journal=$STATE_DIR/journal

# 1 回ずつ動かす。ロックはプロセスが終われば外れるので、落ちた実行の印は残らない。
# --check は何も書かないので、ロックも取らない
if ! $check_only; then
  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/lock"
  if ! flock -n 9; then
    log "前の実行が終わっていないので、何もしない"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# compose と Docker

compose() {
  docker compose "$@"
}

# compose.yaml で、指定したイメージを使うサービスの名前と、書いてあるイメージ
find_service() {
  local repo=$1
  compose config --format json |
    jq -r --arg r "$repo" '
      .services | to_entries[]
      | select(.value.image != null)
      | select(.value.image | startswith($r + ":") or startswith($r + "@") or . == $r)
      | "\(.key) \(.value.image)"' |
    head -n 1
}

running_cid() {
  compose ps -q --status running "$1" 2>/dev/null | head -n 1
}

any_cid() {
  compose ps -aq "$1" 2>/dev/null | head -n 1
}

image_of_container() {
  docker inspect -f '{{.Image}}' "$1"
}

revision_of_image() {
  docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null || true
}

health_of() {
  local cid
  cid=$(any_cid "$1")
  [[ -n $cid ]] || {
    echo missing
    return
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

github() {
  local auth=()
  [[ -z $GITHUB_TOKEN ]] || auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fsS -m 30 "${auth[@]}" -H 'X-GitHub-Api-Version: 2022-11-28' "$@"
}

latest_commit() {
  github -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$1/commits/main"
}

# そのコミットで、main への push で動いた CI のワークフローが通ったか
ci_passed() {
  local repo=$1 sha=$2
  github -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$repo/actions/workflows/ci.yml/runs?head_sha=$sha&event=push&per_page=1" |
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
# 書き留め（実行が落ちたときに、次の実行が続きから戻すため）

save_journal() {
  local stage=$1 tmp=$journal.tmp
  {
    printf 'STAGE=%q\n' "$stage"
    printf 'SENDO_SERVICE=%q\nREADER_SERVICE=%q\n' "$SENDO_SERVICE" "$READER_SERVICE"
    printf 'PREV_SENDO_IMAGE=%q\nPREV_READER_IMAGE=%q\n' "$PREV_SENDO_IMAGE" "$PREV_READER_IMAGE"
    printf 'NEW_SENDO_REV=%q\nNEW_READER_REV=%q\n' "$NEW_SENDO_REV" "$NEW_READER_REV"
    printf 'DATA_SRC=%q\nBACKUP_FILE=%q\n' "$DATA_SRC" "$BACKUP_FILE"
  } >"$tmp"
  mv "$tmp" "$journal"
}

clear_journal() {
  rm -f "$journal"
}

# 手元の main のタグを、前のイメージに戻す（次にコンテナを作り直したとき、確かめていない版が動かないように）
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

# sendo-reader を起こす。新しい版を上げるなら、healthy にならなければ前のイメージに戻して、その版を飛ばす
start_reader() {
  compose up -d --no-deps "$READER_SERVICE"
  if [[ -z $NEW_READER_REV ]]; then
    wait_healthy "$READER_SERVICE" || notify "止まった：sendo-reader が healthy にならない（上げていない版）。手で確かめる"
    return 0
  fi
  if wait_healthy "$READER_SERVICE"; then
    return 0
  fi
  docker tag "$PREV_READER_IMAGE" "$READER_IMAGE:main"
  compose up -d --no-deps "$READER_SERVICE"
  skip_revision reader "$NEW_READER_REV"
  if wait_healthy "$READER_SERVICE"; then
    notify "戻した：sendo-reader ${NEW_READER_REV:0:7} が healthy にならないので、前のイメージに戻した。上流の main に次のコミットが入るまで上げない"
  else
    notify "止まった：sendo-reader を前のイメージに戻しても healthy にならない。手で確かめる"
  fi
  NEW_READER_REV=
  return 1
}

# sendo が healthy にならないとき：前のイメージと、上げる直前のバックアップを組で戻す
rollback_sendo() {
  save_journal rolling_back
  if [[ -n $(running_cid "$READER_SERVICE") ]]; then
    save_journal stuck
    notify "止まった：sendo を戻す前に sendo-reader が起きていたので、戻していない（同期の番号が食い違うため）。手で確かめ、$journal を消す"
    exit 1
  fi
  if [[ ! -f $BACKUP_FILE ]]; then
    save_journal stuck
    notify "止まった：sendo を戻すバックアップ（$BACKUP_FILE）がない。手で確かめ、$journal を消す"
    exit 1
  fi
  compose stop "$SENDO_SERVICE"
  compose rm -f "$SENDO_SERVICE"
  ./backup.sh --service "$SENDO_SERVICE" --data "$DATA_SRC" --image "$PREV_SENDO_IMAGE" restore "$BACKUP_FILE"
  restore_tags
  compose up -d --no-deps "$SENDO_SERVICE"
  skip_revision sendo "$NEW_SENDO_REV"
  if ! wait_healthy "$SENDO_SERVICE"; then
    save_journal stuck
    notify "止まった：sendo を前のイメージとバックアップに戻しても healthy にならない。sendo-reader は止めたまま。手で確かめ、$journal を消す"
    exit 1
  fi
  NEW_READER_REV=
  start_reader || true
  clear_journal
  notify "戻した：sendo ${NEW_SENDO_REV:0:7} が healthy にならないので、前のイメージと上げる直前のバックアップに戻した。上流の main に次のコミットが入るまで上げない"
}

# 新しい sendo で起動したあと：healthy を待ち、だめなら戻す。よければ sendo-reader を起こして終わる
after_sendo_started() {
  if ! wait_healthy "$SENDO_SERVICE"; then
    rollback_sendo
    return
  fi
  save_journal sendo_healthy
  finish
}

# sendo は動いている（上げたか、上げる版がなかった）。sendo-reader を起こすか上げて終わる
finish() {
  local done=()
  [[ -z $NEW_SENDO_REV ]] || done+=("sendo を ${NEW_SENDO_REV:0:7} に")
  if start_reader; then
    [[ -z $NEW_READER_REV ]] || done+=("sendo-reader を ${NEW_READER_REV:0:7} に")
  fi
  clear_journal
  ((${#done[@]} == 0)) || notify "上げた：${done[*]}"
}

# 新しい版で起動する前の段で失敗・中断したとき：前のイメージのまま起こし直す
recover_before_start() {
  restore_tags
  [[ -z $BACKUP_FILE ]] || rm -f "$BACKUP_FILE.partial"
  compose up -d --no-deps "$SENDO_SERVICE"
  wait_healthy "$SENDO_SERVICE" || {
    save_journal stuck
    notify "止まった：前のイメージで起こし直した sendo が healthy にならない。手で確かめ、$journal を消す"
    exit 1
  }
  compose up -d --no-deps "$READER_SERVICE"
  wait_healthy "$READER_SERVICE" || notify "止まった：sendo-reader が healthy にならない。手で確かめる"
  clear_journal
}

# 前の実行が途中で落ちていたら、書き留めた段から続きを戻して、この回は終わる
resume() {
  STAGE=
  # shellcheck source=/dev/null
  . "$journal"
  log "前の実行が段「$STAGE」で終わっていないので、続きを戻す"
  case $STAGE in
  pulled)
    restore_tags
    clear_journal
    ;;
  stopping | backing_up)
    recover_before_start
    notify "戻した：前の実行が sendo を上げる前に終わっていたので、前のイメージのまま起こし直した"
    ;;
  sendo_started) after_sendo_started ;;
  sendo_healthy) finish ;;
  rolling_back) rollback_sendo ;;
  stuck)
    log "止まったままになっている。手で確かめてから $journal を消す"
    exit 1
    ;;
  *)
    log "知らない段：$STAGE。手で確かめてから $journal を消す"
    exit 1
    ;;
  esac
}

# ---------------------------------------------------------------------------
# どうするかを決める

# 1 つのサービスを確かめ、「状態、上流の最新のコミット、CI が通ったか、理由」を
# 区切り文字（\x1f。空の欄が詰まらないよう、空白でないもの）でつないで出す。
# 状態は current（最新）／ upgrade（上げてよい）／ block（上げられない）
#   $1: 名前（sendo か reader）、$2: compose に書いたイメージ、$3: リポジトリ、$4: 動いているコミット、$5: イメージ
evaluate() {
  local name=$1 configured=$2 repo=$3 running=$4 image=$5 latest remote ci=false
  out() { printf '%s\x1f%s\x1f%s\x1f%s\n' "$1" "${latest:-}" "$ci" "$2"; }
  if [[ $configured != "$image:main" ]]; then
    out block "main のタグではない（$configured）ので固定と見る"
    return
  fi
  if ! latest=$(latest_commit "$repo"); then
    latest=
    out block "上流の main の最新のコミットを取れない"
    return
  fi
  if ci_passed "$repo" "$latest"; then ci=true; fi
  if [[ $running == "$latest" ]]; then
    out current "動いているのが上流の main の最新（${latest:0:7}）"
    return
  fi
  if ! remote=$(remote_revision "$image") || [[ -z $remote ]]; then
    out block "GHCR の main のイメージを読めない"
    return
  fi
  if [[ $remote != "$latest" ]]; then
    out block "上流の main の最新（${latest:0:7}）のイメージがまだない（GHCR の main は ${remote:0:7}）"
    return
  fi
  if [[ $ci != true ]]; then
    out block "上流の main の最新（${latest:0:7}）の CI が、まだ終わっていないか、落ちた"
    return
  fi
  if [[ $(skipped_revision "$name") == "$latest" ]]; then
    out block "${latest:0:7} は前に戻した版なので、上流の main に次のコミットが入るまで上げない"
    return
  fi
  out upgrade "${running:0:7} → ${latest:0:7}"
}

main() {
  if [[ -f $journal ]]; then
    if $check_only; then
      log "前の実行の書き留め（$journal）が残っている。次の実行は、まずその続きを戻す"
      exit 0
    fi
    resume
    exit 0
  fi

  local sendo_line reader_line
  sendo_line=$(find_service "$SENDO_IMAGE")
  reader_line=$(find_service "$READER_IMAGE")
  [[ -n $sendo_line ]] || {
    log "compose.yaml に $SENDO_IMAGE のサービスがない"
    exit 1
  }
  [[ -n $reader_line ]] || {
    log "compose.yaml に $READER_IMAGE のサービスがない。この例は、sendo と sendo-reader を並べた構成だけで使う"
    exit 1
  }
  SENDO_SERVICE=${sendo_line%% *}
  READER_SERVICE=${reader_line%% *}
  local sendo_configured=${sendo_line#* } reader_configured=${reader_line#* }

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
    log "sendo の /data が、名前付きのボリュームでもバインドマウントでもない。消して戻すとデータを失うので、上げない"
    exit 1
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
    case $BACKUP_DIR in
    /*) BACKUP_FILE=$BACKUP_DIR/sendo-data.tar ;;
    *) BACKUP_FILE=$here/$BACKUP_DIR/sendo-data.tar ;;
    esac
    $check_only || mkdir -p "$BACKUP_DIR"
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

  # イメージを取る前に書き留める（取ると手元の main のタグが進むので、戻す先を残す）
  save_journal pulled
  local pull=()
  [[ -z $NEW_SENDO_REV ]] || pull+=("$SENDO_SERVICE")
  [[ -z $NEW_READER_REV ]] || pull+=("$READER_SERVICE")
  if ! compose pull -q "${pull[@]}"; then
    restore_tags
    clear_journal
    log "イメージを取れなかったので、上げない"
    exit 1
  fi
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

  # バックアップを置く空き（前のバックアップは、新しいものを取る前に消すので、その分も足す）
  local need free old=0
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
  if ! ./backup.sh --service "$SENDO_SERVICE" --data "$DATA_SRC" --image "$PREV_SENDO_IMAGE" create "$BACKUP_FILE" >/dev/null; then
    recover_before_start
    notify "上げなかった：バックアップを取れなかったので、前のイメージのまま起こし直した"
    exit 1
  fi

  save_journal sendo_started
  compose up -d --no-deps "$SENDO_SERVICE"
  after_sendo_started
}

main
log "終わった（$here）"
