//! 実ページから `scripts/skeletonize-page.ts` で機械的に作った骨組み。

fn assert_extracts_body(html: &[u8]) {
    let result = sendo_extract::extract(
        html,
        Some("text/html; charset=utf-8"),
        "https://example.com/article.html",
    )
    .expect("本文を抽出できる");
    assert!(result.text_length > 0);
    assert!(!result.html.trim().is_empty());
}

#[test]
fn extracts_body_from_lead_embeds_1() {
    assert_extracts_body(include_bytes!("fixtures/lead-embeds-1.html"));
}

#[test]
fn extracts_body_from_lead_embeds_2() {
    assert_extracts_body(include_bytes!("fixtures/lead-embeds-2.html"));
}
