# デプロイ

- 状態：提案中
- 関連：[ユーザーと認証](accounts.md)（セルフホスト）、[仕事の流し方](jobs.md)（取得の間隔）、[古い記事の片付け](retention.md)（記事を残す期間）、[MCP サーバー](mcp.md)（OAuth のオリジン）、[テックスタック](tech-stack.md)

Sendo はセルフホストで、使う人がそれぞれ自分の Cloudflare アカウントにデプロイする（[ユーザーと認証](accounts.md)）。何人もが同じリポジトリから、自分の設定でデプロイし、上流の更新を取り込み続けられる形を決める。2026-11-15 に、fork と Workers Builds で実際にデプロイして確かめた。

## 決定

1. **各自が GitHub で fork し、Cloudflare の Workers Builds でつなぐ。** fork の `main` に push すると、Cloudflare がビルドしてデプロイする。
   - Cloudflare の GitHub App の「Repository access」に、fork を入れる。入れていないと、画面から始めたビルドは動くのに、push ではビルドが始まらない
   - 上流の更新は、GitHub の「Sync fork」で取り込む。取り込んだ push で、そのままデプロイされる
   - Worker の名前は `sendo` のままにする。`wrangler.jsonc` の `name` と違うとビルドが失敗し、sendo-reader もこの名前で呼ぶ
   - 手元から `wrangler deploy` することも、これまでどおりできる
2. **デプロイの手順は `package.json` の `deploy` に書き、Workers Builds のデプロイのコマンドは `pnpm run deploy` にする。**
   - 手順は「マイグレーションを当ててから、デプロイする」
   - Workers Builds の既定（`npx wrangler deploy`）はマイグレーションを当てないので、最初に 1 回だけ画面で変えてもらう。`pnpm deploy` は pnpm 自身のコマンドなので、`run` を付ける
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

## 理由

- **fork と Workers Builds**
  - GitHub App は、リポジトリを持つアカウントに入れる決まりになっている。上流（`sendo-feed/sendo`）を、各自の Cloudflare に直接つなぐことはできない
  - fork なら、上流の更新を「Sync fork」1 つで取り込め、それがそのままデプロイになる。各自が API トークンを作って GitHub に置く必要もない
  - 試したとき、ビルドの環境は `.node-version`（24）と `packageManager`（pnpm 11）を読み、何も足さずに動いた
- **手順を `package.json` に書く**：画面に書いた手順は、上流からは直せない。画面には `pnpm run deploy` とだけ書いておけば、手順を変えても、取り込みで各自に届く。
- **マイグレーションを先に当てる**
  - デプロイを先にすると、新しいコードが古いスキーマで動き、足した列を使う文が落ちる
  - 先に当てれば、デプロイし終えるまでの間、古いコードが新しいスキーマで動くだけになる。足すだけの変更なら困らない
- **ID を書かない**：ID は人ごとに違う。リポジトリに書くと、fork ごとに書き換えが要り、上流の取り込みで衝突する。試したとき、初めてのデプロイで名前のとおりに作られ、2 回目からは受け継いだ（ログに `inherited` と出る）。
- **設定を画面に置く**
  - Wrangler は、画面で変えた変数を、次のデプロイで `wrangler.jsonc` の値に戻す。`vars` に置いたままだと、各自が fork で `wrangler.jsonc` を書き換えるしかない。そうすると上流の取り込みで衝突しうるし、公開の fork に自分の URL を載せることにもなる
  - `keep_vars: true` にすると、Wrangler はデプロイのときに、画面の変数を残すよう Cloudflare に頼む。同じ名前を `vars` にも置くと紛らわしいので、`vars` からは外す
- **秘密を画面から入れる**：画面からリポジトリをつなぐと、1 回目のビルドが止まっても Worker ができるので、そのまま画面から入れられる。Wrangler が案内する `--secrets-file` のように、秘密のファイルを作って置かずに済む。
- **`workers_dev` と `preview_urls` を書く**
  - 画面が作った Worker は、どちらもオフで始まる。書かないと、デプロイのたびに違いの警告が出て、既定のオンで上書きされる
  - Workers Builds は、`main` 以外のブランチを push すると、その版を上げる。プレビューの URL がオンだと、その版を、本番の D1 と秘密につながったまま外から呼べてしまう

## 検討した代替案

- **上流のリポジトリを直接つなぐ**：GitHub App はリポジトリを持つアカウントに入れるので、ほかの人はつなげない。
- **Deploy to Cloudflare のボタン**
  - 最初の設定（D1 と Queues を作る、秘密を聞く）は一番楽
  - ただ、リポジトリを各自のアカウントに複製するだけで、上流の更新を取り込む道がない（手で git を扱う）
  - fork の手順が整ってから、入口として足すのはよい
- **各自の fork で、GitHub Actions からデプロイする**：手順を自由に書け、テストも先に流せる。ただ、各自が API トークンを作って GitHub に置く必要がある。fork では Actions が止まっているので、有効にする手間もかかる。
- **人ごとの設定を、fork の `wrangler.jsonc` に書く**：素直だが、上流が近くの行を変えると、取り込みで衝突する。公開の fork に自分の URL が載る。
- **人ごとの設定を、秘密として入れる**：デプロイで消えないが、値が画面で見えなくなる。秘密でないものを秘密に置くのは紛らわしい。
- **人ごとの設定を D1 に置き、画面から変える**：画面と API が要る。今は 4 つで、変えるのはデプロイする人だけ。

## 見直す条件

- 独自のドメインを使う人が出たとき。`workers_dev` と `routes` を、`wrangler.jsonc` と画面のどちらで持つかを決め直す。
- Cloudflare が、fork なしで上流のリポジトリを追えるようになったとき。または、Deploy ボタンで作ったリポジトリに上流の更新を取り込めるようになったとき。
- 前の版のコードと両立できないマイグレーションが、どうしても要るとき。
- Cloudflare 以外のデプロイ先を作るとき（[テックスタック](tech-stack.md)）。
