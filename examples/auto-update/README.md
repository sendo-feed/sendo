# 自動で更新するスクリプトの例

Docker Compose で動かしている Sendo と sendo-reader を、上流の `main` に自動で追いつかせる例です（[決定](../../docs/decisions/container.md)の 13）。基本の手順は、手で `docker compose pull && docker compose up -d` するままです。自動で上げたい人だけが使います。

汎用の自動更新の道具（Watchtower など）は、イメージが新しくなったコンテナを作り直すだけです。Sendo では、マイグレーションが起動するときに当たり、前の版のイメージに戻しても DB は戻りません。この例は、上げる前のバックアップ、sendo のあとに sendo-reader を上げる順番、healthy にならないときのイメージとバックアップの組での戻しを守ります。

## 置くもの

| ファイル | 中身 |
|---|---|
| `auto-update.sh` | 更新のスクリプト。`--check` で、何をするかを出すだけにする |
| `backup.sh` | sendo のデータ（`/data`）のバックアップを取る ／ 戻す。手で使ってもよい |
| `auto-update.env.example` | 知らせの送り先、healthy を待つ上限、バックアップの置き場などの設定の例 |
| `crontab.example` | cron の設定の例 |

## 使い方

1. `auto-update.sh` と `backup.sh` を、`compose.yaml` と `.env` を置いたディレクトリに取ってきて、実行できるようにする

   ```sh
   for f in auto-update.sh backup.sh auto-update.env.example; do
     curl -fsSLO "https://raw.githubusercontent.com/sendo-feed/sendo/main/examples/auto-update/$f"
   done
   chmod +x auto-update.sh backup.sh
   ```

2. 要るものを入れる：Docker と Docker Compose v2（`docker compose config --format json`、`ps --status`、`up --pull never` を使う。Compose 5.7 で確かめた）、`jq`、`curl`、`flock` と `realpath`（util-linux と coreutils）。Linux を想定しています
3. 知らせなどを設定するなら、`auto-update.env.example` を `auto-update.env` に写して書く（書かなくても動きます）。cron から動かすときに、手で動かすときと違う compose や Docker の設定（`COMPOSE_PROJECT_NAME`、`DOCKER_HOST` など）が要るなら、ここに書く
4. 何をするかを確かめる。何も変えません

   ```sh
   ./auto-update.sh --check
   ```

   ```text
   sendo（sendo）：upgrade：02fe41b → 8352496
   sendo-reader（reader）：current：動いているのが上流の main の最新（90455a7）
   することの順番：
     1. sendo と（上げるなら）sendo-reader のイメージを取り、バックアップを置く場所（…/backups/sendo-data.tar）の空きを確かめる
     2. sendo-reader を止め、sendo を止めて、/data（sendo_sendo-data）をバックアップする
     3. sendo を 8352496 で起こし、healthy を待つ（上限 600 秒）。ならなければ、前のイメージとバックアップに戻す
     4. sendo が healthy になってから、sendo-reader を今のイメージのまま起こす（上げる版がない）
   （--check なので、何も変えていない）
   ```

5. cron に足す（`crontab.example`）。1 時間おきくらいを勧めます。ログ（`auto-update.log`）は増え続けるので、logrotate などで回してください

この例を使うときは、手で `docker compose pull` しないでください。手元の `main` のタグが進み、次にコンテナを作り直したとき（`.env` を変えたあとの `docker compose up -d` など）に、確かめていない版やバックアップを取っていない版が動きます。スクリプトが動いている間は、compose の操作（`up`、`restart`、`stop` など）もしないでください。

## 何をするか

1 回の実行は、次のとおりです。

1. 前の実行が終わっていなければ、何もしない（`flock` のロック。実行が落ちれば外れる）
2. 前の実行が途中で落ちていたら（`.auto-update/journal` が残っていたら）、書き留めた段から続きを戻して終わる
3. `compose.yaml` から、`ghcr.io/sendo-feed/sendo` と `ghcr.io/sendo-feed/sendo-reader` のイメージを使うサービスを探す。ほかのサービスには触らない。sendo-reader がない構成と、sendo のポートを出している構成（sendo-reader と並べていても）では、何もせずに終わる
4. sendo か sendo-reader が動いていなければ、使う人が止めたのかもしれないので、何も変えない
5. それぞれについて、上げてよいかを確かめる。どちらかを上げられなければ、どちらも上げない
   - `compose.yaml` のイメージが `main` のタグ（`sha-<コミット>` のタグやダイジェストで固定していない）
   - GHCR の `main` のイメージ（ラベル `org.opencontainers.image.revision`）が、上流の `main` の最新のコミットのもの
   - そのコミットで、CI のワークフロー（`ci.yml`）が通っている
   - 前に戻して飛ばした版ではない
6. sendo を上げるとき
   1. 前のイメージに `auto-update-prev` のタグを付けてから、新しいイメージを取る。バックアップを置く場所に書けるか、空きが足りるかを確かめる（だめなら上げない）
   2. sendo-reader を止め、sendo を止めて、`/data` をまるごと `backups/sendo-data.tar` にする（前のバックアップは消す）
   3. 新しい sendo を起こし、healthy になるのを待つ
   4. healthy になったら、sendo-reader を起こす（上げてよければ新しいイメージで）。終わったら、前のイメージのタグを外す（使われていなければ、イメージも消える）
   5. healthy にならなければ、sendo を止めて消し、`/data` の中身をまるごとバックアップに置き換えて、前のイメージで起こす。その版は、上流の `main` に次のコミットが入るまで上げない
7. sendo に上げる版がなく、sendo-reader だけにあれば、sendo には触らず sendo-reader を上げる。healthy にならなければ前のイメージに戻す

sendo を上げるあいだ sendo-reader を止めておくのは、healthy になる前の新しい sendo に外から要求を届かせないためです。届いた要求で同期の番号が進んでからバックアップに戻すと、端末が以後の変更を取りこぼします（[差分同期](../../docs/decisions/sync.md)の 1）。同じ理由で、sendo-reader を新しい sendo で起こしたあとは、バックアップで戻しません。

途中でコマンドが失敗したときは、その回のうちに、書き留めた段（`.auto-update/journal`）から戻します。新しい版で起こす前なら前のイメージのまま起こし直し、起こしたあとなら上の 5 のとおりに戻します。実行ごと落ちたとき（ホストの再起動など）は、次の実行が同じように戻します。同じ段から 3 回戻せなければ、止まったとして手に任せます。

上流の `main` には、文書だけの変更でも新しいイメージが出ます。そのたびに、止めてバックアップを取り、新しい sendo が healthy になるまで、画面も使えません（数十秒、データが大きいときやマイグレーションが重いときは数分）。止まるのを減らしたいときは、cron の間隔を広げてください。

前の版のイメージは、上げ終えたら外すので、ふつうはたまりません。戻した回に取った新しい版のイメージは、タグのないまま残るので、ときどき `docker image prune` で消してください。

## 知らせ

`auto-update.env` の `NOTIFY_URL` を書いたときだけ、次のときに送ります。書かなければ、どこにも送りません（ログには出ます）。

- 上げた
- 戻した（healthy にならなかった版、途中で落ちた実行）
- 止まった（戻しても healthy にならないなど。手で確かめる）
- 上げなかった（バックアップを置く空きが足りない、バックアップを取れない）

上流の CI がまだ動いている、などで上げなかった回は、知らせません。

## 止まったとき

戻しても sendo が healthy にならないときなどは、`.auto-update/journal` に「止まった」（`STAGE=stuck`）と書き留め、以後の実行は何もしません（`--check` も、止まっていると出します）。`docker compose logs sendo` などで原因を確かめて直したあと、`.auto-update/journal` を消してください。

止まったとき、手元の `main` のタグは新しい版のままのことがあります。そのまま `docker compose up -d` すると、壊れた新しい版をまた起こします。前の版に戻すときは、書き留めにある前のイメージにタグを付け直してから起こします。

```sh
. .auto-update/journal   # PREV_SENDO_IMAGE、PREV_READER_IMAGE、NEW_SENDO_REV などが読める
docker compose stop reader sendo
docker tag "$PREV_SENDO_IMAGE" ghcr.io/sendo-feed/sendo:main
docker tag "$PREV_READER_IMAGE" ghcr.io/sendo-feed/sendo-reader:main
# 新しい sendo を起こしたあとに止まったなら、データもバックアップに戻す（下）
echo "$NEW_SENDO_REV" > .auto-update/skip-sendo   # この版を飛ばす
rm .auto-update/journal
docker compose up -d --pull never
```

バックアップを手で戻すときは、sendo-reader と sendo を止めてから、次で戻します。戻すと、sendo の同期の番号も戻ります。バックアップを取ったあとに同期した端末があるときは、その端末でログアウトしてログインし直し、最初から同期させてください。

```sh
docker compose stop reader sendo
./backup.sh restore backups/sendo-data.tar
docker compose up -d
```

## 更新を止める

`compose.yaml` の `image` を `sha-<コミット>` のタグかダイジェストにすると、そのサービスは固定され、どちらも上がらなくなります。固定を外すと、また上がります。cron から外してもかまいません。
