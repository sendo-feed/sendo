//! 実在のページ（CNET Japan の記事。sendo と同じ User-Agent で取ったもの）で、本文の範囲を確かめる。
//! `<article>` を使わないページで、抽出器の文章にフッターなど記事の外の文が混じる。

const URL: &str = "https://japan.cnet.com/article/35255203/";

fn extract() -> sendo_extract::Extracted {
    let html = include_bytes!("fixtures/cnet-japan-35255203.html");
    sendo_extract::extract(html, Some("text/html; charset=utf-8"), URL).unwrap()
}

#[test]
fn keeps_the_article_body_without_the_site_frame() {
    let result = extract();
    let html = &result.html;
    // 本文の段落と、キャプション付きの本文の画像
    for text in [
        "Netflixは11月20日、ドラマシリーズ「地面師たち」の新シリーズを制作し",
        "「地面師たち」は、実在の不動産詐欺事件に着想を得た新庄耕の小説を原作とする",
        "今回公開されたビジュアルには、薄暗い部屋の机に広げられた都市の地図",
        "あわせて",
        "大根監督によると、前作の配信直後にNetflixからシーズン2の制作を打診された",
        "原作者の新庄耕は、一度大きな詐欺を成功させた人間は満足せず",
        "「地面師たち」新シリーズのファーストルック（画像：Netflix、©新庄耕／集英社）",
        "body-01.jpg",
    ] {
        assert!(html.contains(text), "missing: {text}");
    }
    // サイトの枠（ナビゲーション、挟み込み、広告、関連記事、フッター、Cookie の案内）
    for text in [
        "Continue to CNET Japan",
        "Newsletter登録",
        "企画広告",
        "編集部おすすめの記事",
        "個人情報保護方針",
        "Copyright",
        "Cookie",
    ] {
        assert!(!html.contains(text), "unexpected: {text}");
    }
}
