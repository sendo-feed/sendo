# デプロイ

- 状態：提案中
- 関連：[ユーザーと認証](accounts.md)（セルフホスト）、[仕事の流し方](jobs.md)（取得の間隔）、[古い記事の片付け](retention.md)（記事を残す期間）、[MCP サーバー](mcp.md)（OAuth のオリジン）、[テックスタック](tech-stack.md)、[コンテナ版](container.md)

Sendo はセルフホストで、使う人がそれぞれ自分の環境にデプロイする（[ユーザーと認証](accounts.md)）。ここで決めるのは、Cloudflare 版を自分の Cloudflare アカウントにデプロイする形。コンテナ版は、上流が作ったイメージを fork せずに使う（[コンテナ版](container.md)の 10）。何人もが同じリポジトリから、自分の設定でデプロイし、上流の更新を取り込み続けられる形を決める。2026-11-15 に、fork と Workers Builds で実際にデプロイして確かめた。2026-11-16 に、上流の更新を自動で取り込む Worker を試し、sendo と sendo-reader の fork が数分で追従するのを確かめた。

## 決定

1. **各自が GitHub で fork し、Cloudflare の Workers Builds でつなぐ。** fork の `main` に push すると、Cloudflare がビルドしてデプロイする。
   - Cloudflare の GitHub App の「Repository access」に、fork を入れる。入れていないと、画面から始めたビルドは動くのに、push ではビルドが始まらない
   - 上流の更新は、GitHub の「Sync fork」で取り込む。取り込んだ push で、そのままデプロイされる。自動で取り込みたい人は、sendo-updater を足す（7）
   - Worker の名前は `sendo` のままにする。`wrangler.jsonc` の `name` と違うとビルドが失敗し、sendo-reader もこの名前で呼ぶ
   - 手元から `wrangler deploy` することも、これまでどおりできる
2. **デプロイの手順は `package.json` の `deploy` に書き、Workers Builds のデプロイのコマンドは `pnpm run deploy` にする。**
   - 手順は「マイグレーションを当ててから、デプロイする」
   - ただし、D1 がまだなければ（初めてのデプロイ）、先にデプロイして、Wrangler に D1 と Queues を作らせる。そのあとでマイグレーションを当て、もう一度デプロイする。D1 があるかは、手順の中で確かめる
   - Workers Builds の既定（`npx wrangler deploy`）はマイグレーションを当てないので、リポジトリをつなぐときに、画面のコマンドを変えてもらう。初めてのデプロイも含めて、このコマンドのままでよい。`pnpm deploy` は pnpm 自身のコマンドなので、`run` を付ける
   - マイグレーションは、前の版のコードでも動く形にする。列や表を足すのはその版で、消す・名前を変えるのは、使わなくなった次の版で行う
3. **D1 と Queues の ID は、リポジトリに書かない。** `wrangler.jsonc` には名前だけを書く。
   - 初めてのデプロイで、Wrangler が名前のとおりに作る。2 回目からは、デプロイ済みの Worker から受け継ぐ
   - マイグレーションも、手元の `pnpm token:create --remote` も、ID なしで同じ D1 を見つける
4. **人ごとの設定は、Cloudflare の画面の「変数」に置き、`wrangler.jsonc` の `vars` には書かない。** `wrangler.jsonc` を `keep_vars: true` にして、デプロイで消えないようにする。
   - 対象は、`PUBLIC_URL` と `READER_URL`（[MCP サーバー](mcp.md)の 4）、`FETCH_INTERVAL_MINUTES`（[仕事の流し方](jobs.md)の 6）、`ARTICLE_RETENTION_DAYS`（[古い記事の片付け](retention.md)の 1）
   - 既定値はコードに持つ。何も入れなければ、取得は 30 分おき、記事は 90 日で、OAuth は使わない
   - 手元では、`wrangler dev` の `--var` で入れる。`secrets` を書いているので、`.dev.vars` からは `secrets.required` の名前しか読まれない
5. **秘密は、初めてのビルドが止まったあとで、画面から入れる。**
   - `secrets.required` の秘密がないと、1 回目のビルドは止まる。それでも Worker と D1 と Queues はできているので、画面の「変数とシークレット」に入れて、ビルドをやり直す
   - 型は「シークレット」にする。「変数」では必須の確認を通らず、デプロイでも消える
6. **`wrangler.jsonc` に `workers_dev: true` と `preview_urls: false` を書く。**
7. **上流の更新を自動で取り込みたい人は、`sendo-feed/sendo-updater` も fork し、Workers Builds でデプロイする。** 使うかどうかは各自が選ぶ。使わなければ、これまでどおり「Sync fork」で取り込む。
   - sendo-updater は Worker で、Cron Triggers で毎分動く。各自の fork（sendo、sendo-reader、sendo-updater 自身）が上流の `main` に遅れていれば、merge-upstream（「Sync fork」と同じ API）で取り込む。取り込んだ push で、そのままデプロイされる
   - 毎回、GitHub の今の状態（上流との差分）から判断し、状態を持たない
   - sendo-reader は、sendo が上流に追いつき、sendo の `main` の先頭で Workers Builds のチェックが成功してから取り込む
   - 競合で取り込めなければ、上書きせずに止まり、手で直すのを待つ
   - GitHub のトークンは、fine-grained personal access token にする。対象を各自の fork に絞り、Contents と Workflows の書き込みだけを与える。sendo-updater の Worker の秘密に置き、GitHub には置かない
   - fork の持ち主（GitHub のユーザーか組織）は、画面の変数に置く（4 と同じ）

## 理由

- **fork と Workers Builds**
  - GitHub App は、リポジトリを持つアカウントに入れる決まりになっている。上流（`sendo-feed/sendo`）を、各自の Cloudflare に直接つなぐことはできない
  - fork なら、上流の更新を「Sync fork」1 つで取り込め、それがそのままデプロイになる。各自が API トークンを作って GitHub に置く必要もない
  - 試したとき、ビルドの環境は `.node-version`（24）と `packageManager`（pnpm 11）を読み、何も足さずに動いた
- **手順を `package.json` に書く**：画面に書いた手順は、上流からは直せない。画面には `pnpm run deploy` とだけ書いておけば、手順を変えても、取り込みで各自に届く。
- **マイグレーションを先に当てる**
  - デプロイを先にすると、新しいコードが古いスキーマで動き、足した列を使う文が落ちる
  - 先に当てれば、デプロイし終えるまでの間、古いコードが新しいスキーマで動くだけになる。足すだけの変更なら困らない
- **初めてだけデプロイを先にする**
  - マイグレーションのコマンドは、名前で D1 を探すだけで、なければ作らずに止まる。D1 を作るのはデプロイ（Wrangler の自動の用意）なので、初めてはデプロイを先にするしかない
  - 秘密をまだ入れていなければ、デプロイは D1 と Queues を作ったあとで止まり、コードは動かない（5）。入れてあれば、表のないまま少しの間動くが、続けてマイグレーションを当てて、デプロイし直す
  - 初めてだけ既定のコマンドで動かし、あとで変えてもらう手もある。ただ、変え忘れると、マイグレーションを当てないままデプロイし続ける
- **ID を書かない**：ID は人ごとに違う。リポジトリに書くと、fork ごとに書き換えが要り、上流の取り込みで衝突する。試したとき、初めてのデプロイで名前のとおりに作られ、2 回目からは受け継いだ（ログに `inherited` と出る）。
- **設定を画面に置く**
  - 決め手はセキュリティ。`vars` に置いたままだと、各自が fork で `wrangler.jsonc` を書き換えるしかない。公開のリポジトリの fork は非公開にできないので、`PUBLIC_URL` と `READER_URL` に書いた自分の sendo の URL が公開され、sendo の fork をたどって見つけられてしまう。ログインは許可したメールだけでも、OAuth のメタデータやクライアントの登録（動的登録）は、誰でも呼べる
  - 人ごとのものが、Cloudflare の 1 か所にまとまる。秘密（`ALLOWED_EMAILS` など）は、どのみち画面に入れる
  - Wrangler は、画面で変えた変数を、次のデプロイで `wrangler.jsonc` の値に戻す。`keep_vars: true` にすると、デプロイのときに、画面の変数を残すよう Cloudflare に頼む。同じ名前を `vars` にも置くと紛らわしいので、`vars` からは外す
- **秘密を画面から入れる**：画面からリポジトリをつなぐと、1 回目のビルドが止まっても Worker ができるので、そのまま画面から入れられる。Wrangler が案内する `--secrets-file` のように、秘密のファイルを作って置かずに済む。
- **`workers_dev` と `preview_urls` を書く**
  - 画面が作った Worker は、どちらもオフで始まる。書かないと、デプロイのたびに違いの警告が出て、既定のオンで上書きされる
  - Workers Builds は、`main` 以外のブランチを push すると、その版を上げる。プレビューの URL がオンだと、その版を、本番の D1 と秘密につながったまま外から呼べてしまう
- **自動の取り込みを、Cloudflare の Worker にする**
  - GitHub Actions の `schedule` は当てにならない。2026-11-16 に、fork に毎時取り込むワークフローを足したが、定刻の実行は一度も作られなかった。無効にして有効に戻しても、cron を変えて登録し直しても、作られなかった。同じ症状の報告が 2026-08 から続いていて、GitHub の回答はない
  - Actions で取り込むと、上流がワークフローのファイルを変えた更新を取り込めない。Actions の `GITHUB_TOKEN` は Workflows の権限を持てず、merge-upstream が 422 で止まる。上流の CI のワークフローは、Dependabot の更新でも変わる
  - fork では Actions が止まっていて、有効にする手間がかかる（代替案の「GitHub Actions からデプロイする」と同じ）
  - Cron Triggers は、sendo と同じ Cloudflare のアカウントで動く。sendo と同じく fork と Workers Builds で入れられ、sendo-updater 自身も上流に追従する
  - 毎分、上流との差分から判断するので、取りこぼしても次の分に追いつく。上流の変更は数分でデプロイまで届く
- **sendo-updater を、sendo とは別の Worker にする**
  - fork に書き込めるトークンを、外から呼ばれ、信頼できないフィードの中身を扱う sendo の Worker に置かない
  - sendo-reader だけを更新したいときも、sendo のデプロイと切り離せる
- **sendo-reader を、sendo のデプロイが成功してから取り込む**：API を足したとき、sendo-reader が先に出ると、まだない API を呼ぶ。時刻をずらすだけでは、ビルドの時間や失敗で順番が崩れる。2026-11-16 には、sendo のデプロイが R2 を有効にしていないことで止まり、sendo-reader はそれを待って、sendo を直した1分後に取り込まれた
- **トークンの権限**
  - Contents の書き込みは、merge-upstream に要る。Workflows の書き込みは、上流がワークフローを変えた更新を取り込むのに要る
  - このトークンがあれば、fork の `main` に書き込め、そのままデプロイに届く。ただ、置き場所は Cloudflare の秘密だけで、sendo-updater には外から呼ばれる入口がない。Cloudflare のアカウントを取られれば、どのみちデプロイは乗っ取られるので、それより大きな穴は増えない
  - トークンを作る手間は、自動で取り込みたい人だけにかかる。「Sync fork」で取り込む人は、これまでどおりトークンが要らない

## 検討した代替案

- **上流のリポジトリを直接つなぐ**：GitHub App はリポジトリを持つアカウントに入れるので、ほかの人はつなげない。
- **Deploy to Cloudflare のボタン**
  - 最初の設定（D1 と Queues を作る、秘密を聞く）は一番楽
  - ただ、リポジトリを各自のアカウントに複製するだけで、上流の更新を取り込む道がない（手で git を扱う）
  - fork の手順が整ってから、入口として足すのはよい
- **各自の fork で、GitHub Actions からデプロイする**：手順を自由に書け、テストも先に流せる。ただ、各自が API トークンを作って GitHub に置く必要がある。fork では Actions が止まっているので、有効にする手間もかかる。
- **人ごとの設定を、fork の `wrangler.jsonc` に書く**
  - 設定が git に残り、`keep_vars` もコードの手直しも要らないので、作りは簡単になる
  - 上流の取り込みでの衝突は、防げる。人ごとの設定を `vars` の最後にまとめ、「この下は fork で書き換える」という注記の行で区切り、上流ではその下を変えない決まりにすればよい
  - それでも、自分の sendo の URL が公開の fork に載るので、セキュリティを理由にとらない
- **人ごとの設定を、秘密として入れる**：デプロイで消えないが、値が画面で見えなくなる。秘密でないものを秘密に置くのは紛らわしい。
- **人ごとの設定を D1 に置き、画面から変える**：画面と API が要る。今は 4 つで、変えるのはデプロイする人だけ。
- **各自の fork の GitHub Actions で、定刻に取り込む**：仕組みは一番小さい。ただ、`schedule` が当てにならず、ワークフローの変更を取り込めず、fork で Actions を有効にする手間もかかる（理由を参照）。
- **sendo-updater から、fork の取り込みのワークフローを起動する（workflow_dispatch）**
  - トークンは Actions の権限だけで済み、取り込みの失敗も GitHub から知らされる
  - ただ、上流に取り込みのワークフローを置き、各自が fork で Actions を有効にする必要がある。ワークフローの変更を取り込むには、結局、別に Workflows の権限のトークンが要る
- **上流の push を webhook で受けて取り込む**：遅れはさらに縮む。ただ、webhook は上流の持ち主が設定するもので、各自の sendo-updater の URL を上流は知らない。外から呼ばれる入口と、署名の確かめも要る。
- **取り込みを sendo の Worker の Cron Triggers に入れる**：リポジトリは増えない。ただ、fork に書き込めるトークンを、外から呼ばれる sendo の Worker に置くことになる（理由を参照）。

## 見直す条件

- 独自のドメインを使う人が出たとき。`workers_dev` と `routes` を、`wrangler.jsonc` と画面のどちらで持つかを決め直す。
- Cloudflare が、fork なしで上流のリポジトリを追えるようになったとき。または、Deploy ボタンで作ったリポジトリに上流の更新を取り込めるようになったとき。
- 前の版のコードと両立できないマイグレーションが、どうしても要るとき。
- GitHub が fork を上流に自動で追従させる仕組みを持ったとき。または、Actions の `schedule` が当てになり、`GITHUB_TOKEN` でワークフローの変更も取り込めるようになったとき。sendo-updater をやめられる。
