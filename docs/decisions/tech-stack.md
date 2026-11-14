# テックスタック

- 状態：提案中
- 関連：[インセプションデッキ](../inception-deck.md)、[技術構成](../tech-deck.md)

## 決定

1. **言語は TypeScript、フレームワークは Hono** にする。
2. **第1版は Cloudflare だけを対象に作る。** Workers・D1・Queues・Cron Triggers を使い、Node や Docker 版は作らない。
3. **Cloudflare 固有の機能は緩衝層（`src/platform/`）の内側に閉じ込める。** あとで Node ／ Bun ＋ SQLite（さらに Postgres）へ移すときは、緩衝層の実装を足すだけで済むようにする。

### 緩衝層で隠すもの

| 役割 | 第1版（Cloudflare） | 移植するときの候補 |
|---|---|---|
| DB | D1 ＋ Drizzle（sqlite-core） | better-sqlite3 ／ libsql、のちに Postgres |
| ジョブキュー | Queues | SQLite のジョブ表を回す仕組み |
| 定期実行 | Cron Triggers（`scheduled`） | Node 側のスケジューラ |
| オブジェクト保存（任意） | R2 | ローカルファイル ／ S3 互換 |
| 意味検索（Phase 3） | Vectorize | sqlite-vec ／ pgvector |
| 認証 | Cloudflare Access の JWT 検証 ／ API トークン | API トークン ／ OAuth |
| 設定・秘密情報 | `env` バインディング | 環境変数 |

### 守る規約

- Cloudflare の型やバインディング（`env.DB`、`env.QUEUE`、`cloudflare:*` からの import）に触れてよいのは、`src/platform/cloudflare/` と入口の `src/index.ts` だけにする。それ以外（`api/`、`fetcher/`、`jobs/` など）は `src/platform/` のインターフェース越しに使う。この規約は Biome の `noRestrictedImports` で機械的に検査する。
- `scheduled` と `queue` の入口は薄くし、中身は普通の関数（例：`runScheduledFetch(deps)`）にする。どの実行環境からでも同じ関数を呼べるようにするため。
- Web 標準の API（`fetch`、`Request`、`Response`、Web Crypto、Streams）だけを使い、`node:*` のモジュールには頼らない。
- D1 は対話的なトランザクションが使えないため、複数の書き込みはまとめて実行する（batch）前提で書く。この書き方は SQLite に移してもそのまま動く。
- スキーマとマイグレーションは SQLite の方言で書く。FTS5 は SQLite 固有なので、全文検索も緩衝層の内側に置く。

## 理由

- **公開までの速さとコスト**：Cloudflare の無料枠で運用費ゼロのまま始められる。対象を1つに絞れば Phase 1 が早く終わる。トレードオフスライダーでも、ランニングコストの低さと試作の速さを上位に置いている。
- **移植の余地**：Hono、Drizzle、Web 標準 API はどれも Node ／ Bun で動く。固有の部分を緩衝層に閉じ込めておけば、移すときの作業はそこだけで済む。第1版での「移植しやすさ」は、すぐ移植できることではなく、移植の妨げを作らないことを指す。
- **reader との共有**：sendo-reader も TypeScript なので、OpenAPI から生成した型をそのまま共有できる。MCP の TypeScript SDK も成熟している。

## 検討した代替案

- **Cloudflare 専用で、緩衝層なし**：最速だが、あとから Cloudflare 依存をはがす作業が大きくなる。
- **第1版から Cloudflare と Node の両方を支える**：最初から移植しやすいが、両方の実装と CI の手間で Phase 1 が遅れる。
- **Go の単一バイナリ ＋ SQLite**：VPS や Docker にはとても載せやすいが、Workers では動かず、reader と言語が分かれる。
- **Rust**：性能は高いが、Phase 1 には重すぎる。ボトルネックが見えたら、一部だけを Wasm にする選択肢として残す。

## 見直す条件

- 試作して、緩衝層の手間が見合わないと分かったとき。
- 2人のどちらかが、Cloudflare 以外のデプロイ先を必要としたとき。Node ／ Docker 版をいつ作るか、Postgres をどこまで支えるかは、そのときに決める（技術構成の未決事項 3）。
