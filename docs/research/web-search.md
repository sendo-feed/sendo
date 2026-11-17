# 関連記事の Web 検索

- 状態：調査中
- 更新日：2026-11-18
- 調査日：2026-11-17〜18（日本時間）
- 関連：[機能一覧](../features.md)、[テックスタック](../decisions/tech-stack.md)、[コンテナ版](../decisions/container.md)

読んでいる記事について、購読外の解説、一次資料、別の視点を探す機能を検討する。購読済みの記事を引く全文検索・意味検索とは対象が違う。

RustXNG の導入を起点に、検索元の品質・利用枠、Google の検索結果を返す外部 API、Claude Platform の Web Search まで調べた。検索に使うサービスはまだ選んでいない。Claude Platform の利用準備と実測は、調査を再開するときに行う。

## 導入の方針

RustXNG を使う場合は、Sendo にライブラリとして組み込まず、別コンテナにして Compose で並べる。既存のテックスタック・コンテナ版の決定に沿う。

- 検索を使う人だけが起動し、Sendo から内部ネットワークで HTTP 接続する。RustXNG のポートは外に公開しない。
- RustXNG の更新・再起動とリソース制限を Sendo と分ける。検索が使えない間も、記事を読む機能は動かせるようにする。
- ライブラリ組み込みなら省ける HTTP 通信、JSON 変換、別プロセスの負担は増える。コンテナ分離による CPU・常駐メモリの増分は未測定。
- Compose の `profiles` はサービスの起動を切り替える機能なので、Sendo 側の接続設定・機能の有効化も合わせて設計する。

当初の機能案は、読者が求めたときに検索し、検索語を確認・編集できるようにすること。記事本文の自動送信、自動検索、自動購読はまだ決めていない。

## RustXNG の仕様と試し検索

[RustXNG](https://github.com/RustXNG/RustXNG) は、複数の検索元に問い合わせて結果をまとめるメタ検索サーバー。自分でサーバーを動かしても、Standard 設定では外部サービスへ検索語が送られる。

2026-11-17 の確認では、最新リリースは [v0.32.0](https://github.com/RustXNG/RustXNG/releases/tag/v0.32.0)。Standard は 34 件の検索元を設定しているが、実際に呼ぶ検索元はカテゴリなどで変わる。Bing・Brave・DuckDuckGo などは既定無効で、一般検索では Mwmbl・Wikipedia・Wiby などが対象になる。[検索元の説明](https://github.com/RustXNG/RustXNG/blob/v0.32.0/docs/PROVIDERS.md)

### 日本語など 8 件の検索

公式の macOS arm64 バイナリ v0.32.0 を、リリース API が返す SHA-256 と照合して起動した。Standard 設定、自前索引なし、`format=json`、`max_results=5`、`strict_engines=1`。表の言語を `language` に指定し、1 件ずつ検索した。記事 20 件での比較評価に進む前の、少数の試し検索である。

| 検索語 | 言語 | 所要時間 | 上位結果の観察 |
|---|---|---|---|
| 生成AI 著作権 | ja | 1.193 秒 | 5 件とも Wikipedia |
| 日銀 利上げ | ja | 0.808 秒 | ニュースも出るが、2025 年の記事を含む |
| 半導体 国産化 | ja | 0.912 秒 | 5 件とも Wikipedia |
| Cloudflare Workers D1 | ja | 0.811 秒 | D1 以外の Workers 関連ページも多い |
| SQLite WAL checkpoint | en | 0.576 秒 | SQLite の公式文書・フォーラムが見つかる |
| Rust async Tokio | ja | 0.393 秒 | Tokio の公式サイト・解説が見つかる |
| 富士山 | ja | 0.825 秒 | Wikipedia、観光・画像関連のページなど |
| 京都 紅葉 | ja | 0.833 秒 | 2019 年の記事や関連の薄い結果も含む |

8 件とも HTTP 200 で 5 件を返し、中央値は約 0.82 秒。1 件では Wikidata の部分失敗も返った。同じ条件で最初の検索を繰り返すと約 0.089 秒だった。この測定から、通常の応答時間や検索品質の優劣を一般化はしない。

追加で 3 件を試した。

- 「日銀 利上げ」に `time_range=month` を付けても、2025 年の記事が残った。検索元ごとに期間指定への対応が違う。
- 同じ語を `categories=news` で検索すると、Wikinews の 1 件だけだった。
- 「Cloudflare Workers D1」を `categories=general,it,news` で検索すると、Hacker News の関連投稿が増えた。検索元の一部失敗もあった。

背景情報や技術資料には使えそうだが、日本語の最新ニュースを探す用途では、検索元とカテゴリを含めた評価が必要。

API の境界も確認した。検索語なしと、`strict_engines=1` で未知の検索元を指定した場合は JSON の HTTP 400。結果なしは HTTP 200・空配列だった。`/healthz` と `/readyz` の成功だけでは、検索元が実際に応答することは確かめられない。[HTTP API](https://github.com/RustXNG/RustXNG/blob/v0.32.0/docs/openapi.yaml)

### 配布イメージ

調査時に README が案内していた `ghcr.io/sahenjp/rustxng:latest` は、取得して `--version` を実行すると v0.31.2 だった。amd64・arm64 のマニフェストがあり、手元で取得した arm64 イメージは約 58 MB、非 root ユーザーで動く。

確認したマニフェストの digest は `sha256:3cdd7dbd1734e53693252ecf875b3fab3f3294fde5523aeeb7c79422e2529839`。同じ名前の `0.32.0` タグは取得できず、移転先候補の `ghcr.io/rustxng/rustxng:0.32.0` は認証エラーだったため、v0.32.0 イメージの公開状況は未確認。上の検索実測は macOS バイナリであり、コンテナ版の実測とは分ける。

採用時には、配布先とバージョンの対応を確認し、試したイメージの digest を固定する。イメージサイズは実行中のメモリ使用量ではない。

## Mwmbl と検索元の条件

[Mwmbl](https://github.com/mwmbl/mwmbl) は、独自の検索索引を持つ非営利・オープンソースの検索エンジン。コミュニティがページの収集や順位の改善に参加する。RustXNG の一部として検索索引まで同梱されるものではなく、今回使ったのは Mwmbl の公開 API。

[公式 API 案内](https://developer.mwmbl.org/)では、匿名枠は送信元 IP 単位で月 1,000 回・毎秒 1 回。同じサーバーの利用者で枠を共有する。登録した無料枠は API キーが必要で月 2,000 回・毎秒 5 回。これは Mwmbl の枠であり、RustXNG 全体の制限ではない。

[利用条件](https://developer.mwmbl.org/terms/)では、API の利用条件と、返す検索結果データの CC BY-NC-SA 4.0 を分けている。元の記事すべてにこのライセンスが付くわけではない。採用するなら表示・保存・再配布の範囲と出典情報の扱いを確認する。Mwmbl を検索元として使うかは未定。

Full 設定は、追加の検索元ごとの条件を確認してから選ぶ。RustXNG の設定で有効にできることだけを、利用許諾の確認には使わない。

## Google の検索結果を使う選択肢

### Google が提供する機能

[Custom Search JSON API](https://developers.google.com/custom-search/v1/overview) は新規受付を終了し、既存利用者も 2027-01-01 までに移行するよう案内されている。GCP のプロジェクトで有効化・課金する場合も同じ API の終了対象。[Google の移行案内](https://programmablesearchengine.googleblog.com/2026/01/updates-to-our-web-search-products.html)

Google の検索ページを直接取得・解析する実装は技術的には考えられるが、取得条件、HTML・JavaScript の変更、CAPTCHA・アクセス拒否への対応を維持する負担がある。自前の取得器を作っても、Google から継続して結果を得られるかは別に確かめる必要がある。[SearXNG の Google 実装](https://docs.searxng.org/_modules/searx/engines/google.html)

[Gemini の Grounding with Google Search](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search) は、検索を使った生成回答と引用元を返す機能。検索結果の一覧を取得する API とは使い方・表示条件が違う。

### 外部サービス

公開資料で調べた基本料金。API キーを使った品質・速度の比較は未実施。米ドル表記で、取得件数や追加機能によって料金が変わる。

| サービス | 無料枠・試用 | 最小の有料利用と注意点 |
|---|---|---|
| [Serper](https://serper.dev/) | 試用 2,500 検索 | $50 で 50,000 検索。月額契約なし。クレジットは 6 か月で失効 |
| [SerpApi](https://serpapi.com/pricing) | 毎月 250 検索 | 月 $25 で 1,000 検索。成功した検索を計上し、キャッシュ応答・失敗は対象外 |
| [SearchApi](https://www.searchapi.io/pricing) | 試用 100 検索 | 月 $40 で 10,000 検索。失敗したリクエストは課金対象外 |
| [DataForSEO](https://dataforseo.com/pricing/google-serp/google-organic-serp-api) | 新規アカウントに $1 相当 | 最低 $50 を入金し従量課金。Live は $2／1,000 検索から。[残高は期限なし](https://dataforseo.com/Pricing) |

各社とも地域・言語の指定とニュース検索を提供するが、日本語の記事の品質・鮮度は同じ検索語で比べる。DataForSEO の Standard は平均約 5 分、Live は平均約 6 秒との提供元の説明。読者がその場で使う機能では Live が候補になる。`site:` などの演算子は基本料金の 5 倍、10 件を超える取得なども加算される。

Serper の規約は B2B 向けと明記しているため、個人で動かす Sendo への適用範囲は確認が残る。Serper・SearchApi のデータ条件には、第三者の権利や出典・著作者表示の扱いがある。API の契約だけで、元の記事や画像の転載が一括で許されるわけではない。[Serper 規約](https://serper.dev/terms)、[SearchApi 規約](https://www.searchapi.io/legal/terms)

RustXNG v0.32.0 には各社専用の接続実装は見当たらないが、[汎用の json_engine](https://github.com/RustXNG/RustXNG/blob/v0.32.0/src/engines/json_engine.rs) がある。GET と JSON で基本検索を行う SerpApi・SearchApi は設定による接続候補。ただし、汎用実装には公開日を取り込む処理がなく、ニュースの日付を返すには拡張が必要そう。Serper・DataForSEO は認証と POST 形式も含めて接続方法を検討する。いずれも未接続。

## Claude Platform の Web Search

Claude に検索語の作成、検索、結果の選別、関連する理由の説明まで任せる案。Sendo から Claude API を呼び、関連記事の候補と引用を受け取る。RustXNG を使う案と並べて検証する。

[公式仕様](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)では、Web Search を Messages API のツールとして渡せる。1 回の依頼で複数回検索でき、`max_uses` で検索回数の上限を指定できる。検索結果の URL・タイトルなどを取得できる一方、内容本体は `encrypted_content` なので、通常の検索 API のような抜粋の取得とは扱いが違う。Google の結果と一致する保証もない。

[料金](https://platform.claude.com/docs/en/about-claude/pricing)は検索 1,000 回につき $10 とモデルのトークン料金。依頼 1 回あたり検索 3 回という仮定なら、1,000 依頼の検索部分は $30 になり、トークン料金が加わる。検索結果も入力トークンとして数える。

「この記事を理解するのに役立つ関連記事を 5 件、各記事が役立つ理由を短く添える」を最初の評価課題にする案がある。結果を探すだけの API より費用が増えても、選別と説明の実装を減らせるかを測る。

## 調査を再開するとき

1. Claude Platform の利用を有効化し、組織の Web Search 設定、API キー、課金・利用上限を確認する。今回の調査では設定変更・契約・有料 API の呼び出しは行っていない。
2. 実際に読む記事を 20 件ほど選び、日本語ニュース、技術解説、背景情報で同じ評価課題を作る。
3. Claude Web Search と検索 API を比べる。関連性、一次資料、鮮度、元記事の重複、出典の正確さ、応答時間、依頼あたりの検索回数・料金を記録する。
4. 検索結果の一覧を出すか、理由・説明まで返すか、LLM 未設定時にも使える機能にするかを決める。サービスに送る情報、表示・保存の条件も合わせて決める。
5. 採用する方式が固まったら機能の決定文書を別 PR で作り、API・Reader の実装範囲を決める。

RustXNG を接続する実装では、任意の機能を `Platform` と `/features` で表す。現在の `safe-fetch` は内部 IP を拒むので、管理者が指定した内部サービスへの接続を緩衝層で扱い、外部 URL の SSRF 対策を緩めない。タイムアウト・結果なし・部分失敗を扱い、API キーをログやレスポンスに出さない。
