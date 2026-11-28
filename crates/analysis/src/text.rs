//! 記事の HTML を、解析の入力のプレーンテキストにする（記事の解析の 7、8）。

use std::sync::OnceLock;

use dom_query::Document;
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

/// 受け付ける HTML の大きさの上限。抜いた本文は 256KB を超えない（記事の本文の 10）
pub const MAX_INPUT_BYTES: usize = 512 * 1024;

fn urls() -> &'static Regex {
    static URLS: OnceLock<Regex> = OnceLock::new();
    URLS.get_or_init(|| Regex::new(r"https?://[^\s<>]+").expect("valid regex"))
}

/// HTML をプレーンテキストにする。コードブロック（`pre`）と、読まれない要素（`script` など）と、
/// URL の形をした文字列を除く。リンクの文字と文中のコードは残す。NFKC で正規化し、行の中の空白を
/// 1 つにそろえる（ブロックの境目の改行は残す。並びがブロックをまたがないようにするため）
pub fn plain_text(html: &str) -> String {
    if html.trim().is_empty() {
        return String::new();
    }
    let doc = Document::from(html);
    doc.select("script,style,svg,math,pre,template,noscript")
        .remove();
    let text = doc.formatted_text();
    let text = urls().replace_all(&text, " ");
    normalize(&text)
}

/// NFKC で正規化し、行ごとに空白を 1 つにそろえ、空の行を除く
pub fn normalize(text: &str) -> String {
    let nfkc: String = text.nfkc().collect();
    nfkc.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 先頭の `limit` コードポイントで切る
pub fn truncate_chars(text: &str, limit: usize) -> &str {
    match text.char_indices().nth(limit) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

/// 先頭の `limit` コードポイントで切り、切り目にかかった最後の語を捨てる（記事の解析の 8）
pub fn truncate_at_word(text: &str, limit: usize) -> &str {
    let head = truncate_chars(text, limit);
    if head.len() == text.len() {
        return head;
    }
    let next = text[head.len()..].chars().next();
    let last = head.chars().last();
    match (last, next) {
        (Some(a), Some(b)) if is_word_char(a) && is_word_char(b) => {
            let cut = head
                .char_indices()
                .rev()
                .find(|&(_, c)| !is_word_char(c))
                .map(|(index, c)| index + c.len_utf8())
                .unwrap_or(0);
            &head[..cut]
        }
        _ => head,
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | '+' | '#' | 'ー')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_drops_code_blocks_and_urls_but_keeps_links_and_inline_code() {
        let html = r#"<p>Use <code>kubectl</code> with <a href="https://example.com/x">Kubernetes</a>.</p>
            <pre>getElementById(x)</pre><p>see https://example.com/page now</p><script>var a = 1;</script>"#;
        let text = plain_text(html);
        assert!(text.contains("kubectl"));
        assert!(text.contains("Kubernetes"));
        assert!(!text.contains("getElementById"));
        assert!(!text.contains("example.com"));
        assert!(!text.contains("var a"));
    }

    #[test]
    fn normalize_applies_nfkc_and_keeps_block_breaks() {
        assert_eq!(
            normalize("ＡＷＳ　と\u{3000}ｶﾀｶﾅ\n\n  次の行 "),
            "AWS と カタカナ\n次の行"
        );
    }

    #[test]
    fn truncate_at_word_drops_the_cut_word() {
        assert_eq!(truncate_at_word("Rust Kubernetes", 8), "Rust ");
        assert_eq!(truncate_at_word("Rust Kubernetes", 5), "Rust ");
        assert_eq!(truncate_at_word("Rust", 10), "Rust");
        assert_eq!(truncate_at_word("コンテナ技術", 3), "");
    }
}
