# テックスタック

- 状態：提案中
- 関連：[インセプションデッキ](../inception-deck.md)、[技術構成](../tech-deck.md)、[コンテナ版](container.md)

## 決定

1. **言語は TypeScript、フレームワークは Hono** にする。
2. **Cloudflare 版とコンテナ版の 2 つの版を、同じコードから作る。**
   - Cloudflare 版は、Workers・D1・Queues・Cron Triggers で動かし、無料プランで動く範囲の機能を載せる
   - コンテナ版は、Node ＋ SQLite で動かし、CPU を多く使う機能も含めて、すべての機能を載せる（[コンテナ版](container.md)）
3. **実行環境に固有の機能は、緩衝層（`src/platform/`）の内側に閉じ込める。** 版ごとの実装を `src/platform/cloudflare/` と `src/platform/node/` に置く。
4. **開発ツールは pnpm・Biome・Vitest** にする。どちらの版でも動く処理のテストは、Cloudflare 版の本番と同じ Workers のランタイム（workerd）の中で動かす。コンテナ版の緩衝層と、コンテナ版だけの機能のテストは、Node で動かす。

### 緩衝層で隠すもの

| 役割 | Cloudflare 版 | コンテナ版 |
|---|---|---|
| DB | D1 ＋ Drizzle（sqlite-core） | SQLite のファイル ＋ libsql ＋ Drizzle。Postgres は今は支えない |
| ジョブキュー | Queues。仕事を封筒に束ねて運び、`ctx.exports` で 1 つずつ別の実行で動かす（[仕事の流し方](jobs.md)） | SQLite のジョブの表に積み、同じプロセスで回す |
| 定期実行 | Cron Triggers（`scheduled`） | 同じプロセスのタイマー |
| オブジェクト保存 | R2 | ボリュームの上のファイル |
| 外への取得 | Workers の `fetch`（内部のネットワークには届かない） | 接続する IP アドレスも確かめる `fetch` |
| 意味検索（Phase 3） | Vectorize | sqlite-vec |
| 版で有無が分かれる重い処理 | なし | 実装を渡す（[コンテナ版](container.md)の 2） |
| 設定・秘密情報 | `env` バインディング | 環境変数 |

### 守る規約

ここの規約は、2 つの版で動くアプリ本体（`src/`）に適用する。手元の Node で動かす道具（`scripts/` の管理用のコマンド、`*.config.ts` などの設定ファイル）は、アプリ本体としてデプロイしないので対象外とし、`node:*` を使ってよい。

- Cloudflare の型やバインディング（`env.DB`、`env.QUEUE`、`cloudflare:*` からの import）に触れてよいのは、`src/platform/cloudflare/` と入口の `src/index.ts` だけにする。それ以外（`api/`、`fetcher/`、`jobs/` など）は `src/platform/` のインターフェース越しに使う。この規約は Biome の `noRestrictedImports` で機械的に検査する。
- `scheduled` と `queue` の入口は薄くし、中身は普通の関数（例：`runScheduledFetch(deps)`）にする。どちらの版からでも同じ関数を呼べるようにするため。
- Web 標準の API（`fetch`、`Request`、`Response`、Web Crypto、Streams）だけを使い、`node:*` のモジュールには頼らない。例外は、コンテナ版の緩衝層（`src/platform/node/`）だけにする。この規約も Biome の `noNodejsModules` で、`src/` を機械的に検査する。
- 書き込みは、対話的なトランザクションにも batch にも頼らず、何度実行しても同じ結果になる（冪等な）形で組み立てる。途中で失敗しても、やり直せば正しい状態になるようにする（例：一意制約と「あれば飛ばす」で重複を防ぐ、記録は処理の最後に書く）。複数の書き込みを必ずまとめて反映する必要が出たら、そのときに batch を緩衝層の DB に足す。
- 件数などの集計は、別の列に持たずにその都度数える。持つ場合は、いつでも数え直せるようにする（途中で失敗したときにずれないように）。
- スキーマとマイグレーションは SQLite の方言で書き、2 つの版で 1 組だけ持つ。FTS5 は SQLite 固有なので、全文検索も緩衝層の内側に置く。

## 理由

- **2 つの版を持つ：** これから作る機能（全文抽出、画像の縮小、埋め込みの計算など）が、Workers の CPU 時間に収まらなくなってきた。重い処理は、上限のないコンテナで動かす。それでも、サーバーを持たない人が無料で使える Cloudflare 版は残したい。詳しくは[コンテナ版](container.md)の「理由」に書いた。
- **公開までの速さとコスト：** Cloudflare の無料枠なら、運用費ゼロのまま始められる。Phase 1 は Cloudflare だけを対象にして、早く終えられた。トレードオフスライダーでも、ランニングコストの低さと試作の速さを上位に置いている。
- **同じコードから 2 つの版を作る：**
  - Hono、Drizzle、Web 標準 API は、どれも Node でも動く
  - 固有の部分を緩衝層に閉じ込めてあるので、版を足す作業は、緩衝層の実装とそのテストで済む
- **reader との共有：** sendo-reader も TypeScript なので、OpenAPI から生成した型をそのまま共有できる。MCP の TypeScript SDK も成熟している。

## 検討した代替案

- **Cloudflare 専用で、緩衝層なし**：一番速く作れるが、コンテナ版を足すときに、Cloudflare への依存をはがす作業が大きくなる。
- **Cloudflare だけを対象にする**：Phase 1 の間はこれにして、早く終えられた。ただ、これから作る機能が CPU 時間の上限に収まらなくなってきた（[コンテナ版](container.md)）。
- **Go の単一バイナリ ＋ SQLite**：VPS や Docker にはとても載せやすいが、Workers では動かず、reader と言語が分かれる。
- **書き込みを batch でまとめる**：途中まで書いた状態が残らないが、batch は D1 と libsql の型にしかなく、緩衝層の共通の型からは呼べない。better-sqlite3 などの、ほかのドライバにもない。キューはもともと失敗するとやり直すので、冪等な書き込みのほうが相性がよい。フィードの取得の試作（#10）で、冪等な書き込みで問題なく動くことを確かめた。
- **Rust**：性能は高いが、Phase 1 には重すぎる。ボトルネックが見えたら、一部だけを Wasm にする選択肢として残す。CPU 時間の上限への対策としては、コンテナ版を選んだ（[コンテナ版](container.md)の代替案）。
- **Bun**：Cloudflare 版は workerd、コンテナ版は Node で動かすので、ランタイムとしては使わない。`bun test` は workerd の中で動かせないので、テストランナーにも使えない。パッケージマネージャーとしては速いが、pnpm で揃えた守り（公開から 14 日待つ、インストール時のスクリプトの許可制、宣言していない依存を使えない厳しさ）を優先した。
- **Vite+（Oxlint・Oxfmt）**：Biome から替える案。速く ESLint 互換のルールが多いが、lint と整形が1つで済み、整形が成熟した Biome を選んだ。Vite が中心になる sendo-reader を作り始めるときに、リポジトリ間で揃えるかを決め直す。
- **Void（Cloudflare、2026年10月公開）**：Vite で作るフルスタックのアプリを Cloudflare にデプロイする SDK・CLI・基盤。フロントエンドを持つアプリ向けで、API ファーストのサーバーである sendo には向かない。リソースの自動用意が Cloudflare に依存していて緩衝層の方針と逆向きで、公開から日も浅い。内部で Hono を使っているので、後から寄せる道は残る。sendo-reader では候補になる（技術構成の未決事項）。

## 見直す条件

- 緩衝層の手間が、2 つの版を持つ利点に見合わないと分かったとき。
- Postgres を支える必要が出たとき（[コンテナ版](container.md)の「見直す条件」）。
