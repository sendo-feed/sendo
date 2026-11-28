//! 記事の HTML を、解析の入力のプレーンテキストにする（記事の解析の 7、8）。

use std::sync::OnceLock;

use dom_query::Document;
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

/// 受け付ける HTML の大きさの上限。抜いた本文は 256KB を超えない（記事の本文の 10）
pub const MAX_INPUT_BYTES: usize = 512 * 1024;

/// URL の形をした文字列。URL に使える ASCII の文字だけを含める（日本語の文が空白なしで続いても、
/// そこで止まるように）
fn urls() -> &'static Regex {
    static URLS: OnceLock<Regex> = OnceLock::new();
    URLS.get_or_init(|| {
        Regex::new(r"(?i)https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+").expect("valid regex")
    })
}

/// 記事の解析の入力。HTML の解析は、候補と埋め込みで分けずに 1 回だけ行う
pub struct ArticleText {
    pub title: String,
    pub summary: String,
    pub body: String,
}

impl ArticleText {
    pub fn from_html(title: &str, summary: &str, body_html: &str) -> Self {
        ArticleText {
            title: normalize(title),
            summary: plain_text(summary),
            body: plain_text(body_html),
        }
    }
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
    // 表のセルと定義の並びは、ブロックの要素でなくても境目にする（隣のセルの語を 1 つの並びにしない）
    doc.select("td,th,dt,dd,caption").after_html("<br>");
    let text = doc.formatted_text();
    // 全角で書いた URL も除けるように、NFKC のあとで除く
    let nfkc = nfkc_without_format_characters(&text);
    let text = urls().replace_all(&nfkc, " ");
    collapse_whitespace(&text)
}

/// NFKC で正規化し、行ごとに空白を 1 つにそろえ、空の行を除く
pub fn normalize(text: &str) -> String {
    collapse_whitespace(&nfkc_without_format_characters(text))
}

/// NFKC で正規化し、書式の文字（ソフトハイフン、ゼロ幅スペースなど）を除く。語の途中に入っていても、
/// 語を割らないようにする
fn nfkc_without_format_characters(text: &str) -> String {
    format_characters()
        .replace_all(&text.nfkc().collect::<String>(), "")
        .into_owned()
}

fn format_characters() -> &'static Regex {
    static FORMAT: OnceLock<Regex> = OnceLock::new();
    FORMAT.get_or_init(|| Regex::new(r"\p{Cf}").expect("valid regex"))
}

fn collapse_whitespace(text: &str) -> String {
    text.lines()
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

/// 先頭の `limit` コードポイントで切り、切り目にかかった最後の語を捨てる（記事の解析の 8）。
/// 語は、候補として拾う語の文字（英数字の語か、カタカナの語）の並び。切り目の両側が同じ種類の
/// 語の文字のときだけ捨てる
pub fn truncate_at_word(text: &str, limit: usize) -> &str {
    let head = truncate_chars(text, limit);
    if head.len() == text.len() {
        return head;
    }
    let next = text[head.len()..].chars().next();
    let kind = match (head.chars().last(), next) {
        (Some(a), Some(b)) => word_kind(a).filter(|k| Some(*k) == word_kind(b)),
        _ => None,
    };
    let Some(kind) = kind else {
        return head;
    };
    let cut = head
        .char_indices()
        .rev()
        .find(|&(_, c)| word_kind(c) != Some(kind))
        .map(|(index, c)| index + c.len_utf8())
        .unwrap_or(0);
    &head[..cut]
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WordKind {
    Ascii,
    Katakana,
}

fn word_kind(c: char) -> Option<WordKind> {
    if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+' | '#') {
        Some(WordKind::Ascii)
    } else if c == 'ー'
        || ('\u{30A1}'..='\u{30FA}').contains(&c)
        || ('\u{30FD}'..='\u{30FF}').contains(&c)
    {
        Some(WordKind::Katakana)
    } else {
        None
    }
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
    fn plain_text_stops_urls_before_japanese_text() {
        let html = r#"<p><a href="https://github.com/x">https://github.com/x</a>を参照。RustとKubernetesの話。</p>"#;
        let text = plain_text(html);
        assert!(!text.contains("github.com"), "{text}");
        assert!(text.contains("を参照。RustとKubernetesの話。"), "{text}");
    }

    #[test]
    fn plain_text_breaks_table_cells_and_definition_lists() {
        let html = "<table><tr><td>Docker</td><td>Kubernetes</td></tr></table><dl><dt>Rust</dt><dd>Fast</dd></dl>";
        let text = plain_text(html);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines,
            vec!["Docker", "Kubernetes", "Rust", "Fast"],
            "{text}"
        );
    }

    #[test]
    fn plain_text_drops_full_width_urls_and_format_characters() {
        let text = plain_text(
            "<p>ｈｔｔｐｓ：／／Example.com/Foo を見る。Kuber\u{AD}netes と コン\u{200B}テナ</p>",
        );
        assert_eq!(text, "を見る。Kubernetes と コンテナ");
    }

    #[test]
    fn normalize_applies_nfkc_and_keeps_block_breaks() {
        assert_eq!(
            normalize("ＡＷＳ　と\u{3000}ｶﾀｶﾅ\n\n  次の行 "),
            "AWS と カタカナ\n次の行"
        );
    }

    #[test]
    fn truncate_at_word_drops_only_the_cut_word_of_the_same_kind() {
        assert_eq!(truncate_at_word("Rust Kubernetes", 8), "Rust ");
        assert_eq!(truncate_at_word("Rust Kubernetes", 5), "Rust ");
        assert_eq!(truncate_at_word("Rust", 10), "Rust");
        assert_eq!(truncate_at_word("コンテナ技術", 3), "");
        // 切れていない語は捨てない（日本語の文字とは種類が違う）
        assert_eq!(truncate_at_word("あいう Rustを使う方法", 8), "あいう Rust");
        assert_eq!(truncate_at_word("あいう Rustを使う方法", 6), "あいう ");
        assert_eq!(
            truncate_at_word("あいう Rustを使う方法", 10),
            "あいう Rustを使"
        );
        let long = format!("{}Rust", "あ".repeat(19_998));
        assert_eq!(truncate_at_word(&long, 20_000).chars().count(), 19_998);
    }
}
