//! 実在のページ（CNET Japan の記事。sendo と同じ User-Agent で取ったもの）で、本文の範囲を確かめる。
//! `<article>` を使わないページで、抽出器の文章にフッターなど記事の外の文が混じる。
//! 記事の文（見出し、本文、キャプション、要約）は、長さと区切りをそろえた検証用の文に置き換えてある。
//! サイトの枠（メニュー、広告、フッターなど）とマークアップは、取ったときのまま。

const URL: &str = "https://japan.cnet.com/article/35255203/";

fn extract() -> sendo_extract::Extracted {
    let html = include_bytes!("fixtures/cnet-japan-35255203.html");
    sendo_extract::extract(html, Some("text/html; charset=utf-8"), URL).unwrap()
}

#[test]
fn keeps_the_article_body_without_the_site_frame() {
    let result = extract();
    let html = &result.html;
    // 見出し、本文の段落、キャプション付きの本文の画像（記事の文は検証用の文に置き換えてある）
    for text in [
        "検証用の記事の見出し",
        "検証用の文1。",
        "検証用の文5。",
        "検証用の文8。",
        "検証用の文11。",
        "検証用の文12。",
        "検証用の文13。",
        // 画像のキャプション
        "検証用の文4。",
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
    // 表紙は画面幅ごとに同じ URL で 2 回書かれている。最初の 1 枚だけを残す
    assert_eq!(
        html.matches("44af4962d01f080e38d36520a25047ff/large.jpg")
            .count(),
        1
    );
}
