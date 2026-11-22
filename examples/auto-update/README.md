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

1. `auto-update.sh` と `backup.sh` を、`compose.yaml` と `.env` を置いたディレクトリに写し、実行できるようにする

   ```sh
   chmod +x auto-update.sh backup.sh
   ```

2. 要るものを入れる：Docker（Compose v2）、`jq`、`curl`、`flock`（util-linux）。Linux を想定しています
3. 知らせなどを設定するなら、`auto-update.env.example` を `auto-update.env` に写して書く（書かなくても動きます）
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

5. cron に足す（`crontab.example`）。1 時間おきくらいを勧めます

この例を使うときは、手で `docker compose pull` しないでください。手元の `main` のタグが進み、次にコンテナを作り直したとき（`.env` を変えたあとの `docker compose up -d` など）に、確かめていない版やバックアップを取っていない版が動きます。スクリプトが動いている間は、compose の操作（`up`、`restart`、`stop` など）もしないでください。

## 何をするか

1 回の実行は、次のとおりです。

1. 前の実行が終わっていなければ、何もしない（`flock` のロック。実行が落ちれば外れる）
2. 前の実行が途中で落ちていたら（`.auto-update/journal` が残っていたら）、書き留めた段から続きを戻して終わる
3. `compose.yaml` から、`ghcr.io/sendo-feed/sendo` と `ghcr.io/sendo-feed/sendo-reader` のイメージを使うサービスを探す。ほかのサービスには触らない。sendo-reader のない構成（sendo のポートを出す構成）では使えない
4. sendo か sendo-reader が動いていなければ、使う人が止めたのかもしれないので、何も変えない
5. それぞれについて、上げてよいかを確かめる。どちらかを上げられなければ、どちらも上げない
   - `compose.yaml` のイメージが `main` のタグ（`sha-<コミット>` のタグやダイジェストで固定していない）
   - GHCR の `main` のイメージ（ラベル `org.opencontainers.image.revision`）が、上流の `main` の最新のコミットのもの
   - そのコミットで、CI のワークフロー（`ci.yml`）が通っている
   - 前に戻して飛ばした版ではない
6. sendo を上げるとき
   1. イメージを取り、バックアップを置く場所の空きを確かめる（足りなければ上げない）
   2. sendo-reader を止め、sendo を止めて、`/data` をまるごと `backups/sendo-data.tar` にする（前のバックアップは消す）
   3. 新しい sendo を起こし、healthy になるのを待つ
   4. healthy になったら、sendo-reader を起こす（上げてよければ新しいイメージで）
   5. healthy にならなければ、sendo を止めて消し、`/data` の中身をまるごとバックアップに置き換えて、前のイメージで起こす。その版は、上流の `main` に次のコミットが入るまで上げない
7. sendo に上げる版がなく、sendo-reader だけにあれば、sendo には触らず sendo-reader を上げる。healthy にならなければ前のイメージに戻す

sendo を上げるあいだ sendo-reader を止めておくのは、healthy になる前の新しい sendo に外から要求を届かせないためです。届いた要求で同期の番号が進んでからバックアップに戻すと、端末が以後の変更を取りこぼします（[差分同期](../../docs/decisions/sync.md)の 1）。同じ理由で、sendo-reader を新しい sendo で起こしたあとは、バックアップで戻しません。

上流の `main` には、文書だけの変更でも新しいイメージが出ます。そのたびに数秒〜数十秒止まってバックアップを取るので、止まるのを減らしたいときは、cron の間隔を広げてください。

## 知らせ

`auto-update.env` の `NOTIFY_URL` を書いたときだけ、次のときに送ります。書かなければ、どこにも送りません（ログには出ます）。

- 上げた
- 戻した（healthy にならなかった版、途中で落ちた実行）
- 止まった（戻しても healthy にならないなど。手で確かめる）
- 上げなかった（バックアップを置く空きが足りない、バックアップを取れない）

上流の CI がまだ動いている、などで上げなかった回は、知らせません。

## 止まったとき

戻しても sendo が healthy にならないときなどは、`.auto-update/journal` に「止まった」と書き留め、以後の実行は何もしません。`docker compose logs sendo` などで原因を確かめて直したあと、`.auto-update/journal` を消してください。

バックアップを手で戻すときは、sendo-reader と sendo を止めてから、次で戻します。戻すと、sendo の同期の番号も戻ります。バックアップを取ったあとに同期した端末があるときは、その端末でログアウトしてログインし直し、最初から同期させてください。

```sh
docker compose stop reader sendo
./backup.sh restore backups/sendo-data.tar
docker compose up -d
```

## 更新を止める

`compose.yaml` の `image` を `sha-<コミット>` のタグかダイジェストにすると、そのサービスは固定され、どちらも上がらなくなります。固定を外すと、また上がります。cron から外してもかまいません。
