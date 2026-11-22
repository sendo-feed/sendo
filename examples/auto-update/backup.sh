#!/usr/bin/env bash
# sendo のデータ（/data）のバックアップを取る ／ 戻す（docs/decisions/container.md の 13）。
# compose.yaml と同じ場所に置いて使う。auto-update.sh も、これを呼ぶ。
#
#   ./backup.sh size                 /data の大きさ（KiB）を出す。sendo が動いていてもよい
#   ./backup.sh create <ファイル>     sendo を止めてから、/data をまるごと tar にする
#   ./backup.sh restore <ファイル>    sendo を止めて消してから、/data の中身をまるごと tar の中身に置き換える
#
# 書き込みの途中の SQLite のファイルを写さないよう、create と restore は sendo が動いていると断る。
# create は <ファイル>.partial に書いてから名前を変えるので、<ファイル> があれば取り終えている。
#
# 選べるもの（ふつうは要らない。auto-update.sh が渡す）
#   --data <ボリューム名か絶対パス>   /data に付けているもの。既定は sendo のコンテナから調べる
#   --image <イメージ>                 tar を動かすイメージ。既定は sendo のコンテナのイメージ
#   --service <名前>                   sendo のサービスの名前。既定は sendo
set -euo pipefail

cd "$(dirname "$0")"

service=sendo
data=
image=

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

die() {
  echo "backup.sh: $*" >&2
  exit 1
}

while (($#)); do
  case $1 in
  --data)
    data=${2:?}
    shift 2
    ;;
  --image)
    image=${2:?}
    shift 2
    ;;
  --service)
    service=${2:?}
    shift 2
    ;;
  -h | --help) usage ;;
  --*) die "知らない指定：$1" ;;
  *) break ;;
  esac
done

command=${1:-}
[[ -n $command ]] || usage

# sendo のコンテナ（止まっていてもよい）。restore では、消したあとなのでないこともある
container_id() {
  docker compose ps -aq "$service" 2>/dev/null | head -n 1
}

if [[ -z $data || -z $image ]]; then
  cid=$(container_id)
  [[ -n $cid ]] || die "$service のコンテナがない。--data と --image を指定する"
  if [[ -z $data ]]; then
    data=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$cid")
    [[ -n $data ]] || die "$service の /data にボリュームが付いていない"
  fi
  if [[ -z $image ]]; then
    image=$(docker inspect -f '{{.Image}}' "$cid")
  fi
fi

ensure_stopped() {
  local cid
  cid=$(docker compose ps -q --status running "$service" 2>/dev/null | head -n 1)
  [[ -z $cid ]] || die "$service が動いている。止めてから（docker compose stop $service）"
}

# /data と、バックアップを置くディレクトリを付けて、イメージの中で sh を動かす（tar などはイメージのものを使う）
run_in_image() {
  local backup_dir=$1
  shift
  docker run --rm --user 0 --network none --entrypoint sh \
    -v "$data:/data" -v "$backup_dir:/backup" "$image" -c "$@"
}

case $command in
size)
  docker run --rm --user 0 --network none --entrypoint sh -v "$data:/data:ro" "$image" \
    -c 'du -sk /data | cut -f 1'
  ;;
create)
  file=${2:?バックアップのファイルを指定する}
  ensure_stopped
  dir=$(cd "$(dirname "$file")" && pwd)
  name=$(basename "$file")
  # shellcheck disable=SC2016 # イメージの中の sh が展開する
  run_in_image "$dir" '
    set -e
    rm -f "/backup/$1.partial"
    tar -C /data --numeric-owner -cf "/backup/$1.partial" .
    sync
    mv "/backup/$1.partial" "/backup/$1"
  ' -- "$name"
  echo "$dir/$name"
  ;;
restore)
  file=${2:?戻すバックアップのファイルを指定する}
  [[ -f $file ]] || die "$file がない（取り終えたバックアップだけを戻す）"
  ensure_stopped
  dir=$(cd "$(dirname "$file")" && pwd)
  name=$(basename "$file")
  # 新しい版が残した WAL や本文のファイルを残さないよう、中身を消してから、まるごと置き換える
  # shellcheck disable=SC2016 # イメージの中の sh が展開する
  run_in_image "$dir" '
    set -e
    find /data -mindepth 1 -delete
    tar -C /data --numeric-owner -xpf "/backup/$1"
    sync
  ' -- "$name"
  ;;
*)
  usage
  ;;
esac
