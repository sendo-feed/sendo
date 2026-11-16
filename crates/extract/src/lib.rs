//! 記事のページから本文を抜く（docs/decisions/content.md の 10〜14）。
//!
//! 外への取得と DB には触らない（docs/decisions/tech-stack.md の 5）。TypeScript の側が取ってきた
//! バイト列を受け取り、文字コードを決めて、Readability（dom_smoothie）で本文を抜いて返す。
//! 返す HTML はサニタイズしていない。サニタイズは TypeScript の側で行う（content.md の 2）。
#![forbid(unsafe_code)]

use encoding_rs::{Encoding, UTF_8};

/// 抜いた本文
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    /// ページのタイトル
    pub title: String,
    /// 本文の HTML（サニタイズしていない）
    pub html: String,
    /// 本文の文字数（タグを除いたもの）
    pub text_length: usize,
}

/// 本文を抜けなかった理由
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtractError {
    /// ページの HTML を読めなかった（document_url が正しくないなど）
    InvalidInput(String),
    /// 本文らしいところが見つからなかった
    NoContent,
}

impl std::fmt::Display for ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractError::InvalidInput(message) => write!(f, "invalid input: {message}"),
            ExtractError::NoContent => write!(f, "no readable content"),
        }
    }
}

impl std::error::Error for ExtractError {}

/// ページの文字コードを探すのに見る、先頭のバイト数（HTML の決まりと同じ）
const META_SNIFF_BYTES: usize = 1024;

/// ページのバイト列から本文を抜く。
///
/// - `content_type`：応答の Content-Type。charset があれば、それで読む
/// - `url`：ページの URL。本文の中のリンクと画像の URL を、これを基準に絶対の URL にする
pub fn extract(
    bytes: &[u8],
    content_type: Option<&str>,
    url: &str,
) -> Result<Extracted, ExtractError> {
    let html = decode(bytes, content_type);
    let mut readability = dom_smoothie::Readability::new(html, Some(url), None)
        .map_err(|error| ExtractError::InvalidInput(error.to_string()))?;
    let article = readability.parse().map_err(|_| ExtractError::NoContent)?;
    let text_length = article.text_content.trim().chars().count();
    if text_length == 0 {
        return Err(ExtractError::NoContent);
    }
    Ok(Extracted {
        title: article.title.trim().to_string(),
        html: article.content.to_string(),
        text_length,
    })
}

/// 文字コードを決めて、文字列にする。
///
/// 決める順は、BOM、Content-Type の charset、ページの先頭の `<meta charset>`（または
/// `<meta http-equiv="Content-Type" content="…; charset=…">`）、どれもなければ UTF-8。
/// 読めないバイトは、置き換えの文字（U+FFFD）にする
pub fn decode(bytes: &[u8], content_type: Option<&str>) -> String {
    let encoding = content_type
        .and_then(charset_from_content_type)
        .or_else(|| charset_from_meta(bytes))
        .and_then(|label| Encoding::for_label(label.as_bytes()))
        .map(html_encoding)
        .unwrap_or(UTF_8);
    // decode は、BOM があれば、それを優先する
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

/// HTML の決まりでは、UTF-16 と書かれていても、BOM がなければ UTF-8 として読む
fn html_encoding(encoding: &'static Encoding) -> &'static Encoding {
    if encoding == encoding_rs::UTF_16BE || encoding == encoding_rs::UTF_16LE {
        UTF_8
    } else {
        encoding
    }
}

/// Content-Type の charset の値
fn charset_from_content_type(content_type: &str) -> Option<String> {
    charset_after(content_type, 0)
}

/// ページの先頭の `<meta>` から、charset の値を探す
fn charset_from_meta(bytes: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(META_SNIFF_BYTES)];
    // 先頭は ASCII で書かれているはずなので、ASCII として読む（ASCII でないバイトは捨てる）
    let text: String = head
        .iter()
        .map(|&byte| {
            if byte.is_ascii() {
                byte.to_ascii_lowercase() as char
            } else {
                ' '
            }
        })
        .collect();
    let mut from = 0;
    while let Some(offset) = text[from..].find("<meta") {
        let start = from + offset;
        let end = text[start..].find('>').map_or(text.len(), |i| start + i);
        let tag = &text[start..end];
        if let Some(charset) = charset_after(tag, 0) {
            return Some(charset);
        }
        from = end;
    }
    None
}

/// text の中で、from から後ろにある最初の `charset=` の値を返す。引用符や空白を除く
fn charset_after(text: &str, from: usize) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let position = lower[from..].find("charset")? + from + "charset".len();
    let rest = lower[position..].trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let rest = rest.trim_start_matches(['"', '\'']);
    let value: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        .collect();
    if value.is_empty() { None } else { Some(value) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(body: &str) -> String {
        format!(
            "<!doctype html><html><head><title>見出し | サイト</title></head><body>\
             <nav>メニュー</nav><article><h1>見出し</h1>{body}</article><footer>フッター</footer></body></html>"
        )
    }

    fn long_paragraphs() -> String {
        (0..8)
            .map(|i| {
                format!(
                    "<p>これは記事の本文の段落 {i} です。Readability が本文だと判断できるように、\
                     ある程度の長さの文章を、いくつかの段落に分けて書いておきます。\
                     <a href=\"/related/{i}\">関連</a></p>"
                )
            })
            .collect()
    }

    #[test]
    fn extracts_the_article_body() {
        let html = page(&long_paragraphs());
        let extracted = extract(
            html.as_bytes(),
            Some("text/html"),
            "https://example.com/posts/1",
        )
        .unwrap();
        assert!(extracted.html.contains("段落 0"));
        assert!(!extracted.html.contains("メニュー"));
        assert!(!extracted.html.contains("フッター"));
        // リンクは、ページの URL を基準に絶対の URL にする
        assert!(extracted.html.contains("https://example.com/related/0"));
        assert!(extracted.text_length > 100);
        assert!(extracted.title.contains("見出し"));
    }

    #[test]
    fn reads_shift_jis_from_the_content_type() {
        let html = page(&long_paragraphs());
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode(&html);
        let extracted = extract(
            &bytes,
            Some("text/html; charset=Shift_JIS"),
            "https://example.com/",
        )
        .unwrap();
        assert!(extracted.html.contains("段落 3"));
    }

    #[test]
    fn reads_euc_jp_from_a_meta_tag() {
        let html = page(&long_paragraphs()).replace(
            "<head>",
            "<head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=EUC-JP\">",
        );
        let (bytes, _, _) = encoding_rs::EUC_JP.encode(&html);
        let extracted = extract(&bytes, Some("text/html"), "https://example.com/").unwrap();
        assert!(extracted.html.contains("段落 5"));
    }

    #[test]
    fn decodes_with_the_meta_charset_and_falls_back_to_utf8() {
        let (bytes, _, _) =
            encoding_rs::SHIFT_JIS.encode("<meta charset='shift_jis'><p>日本語</p>");
        assert!(decode(&bytes, None).contains("日本語"));
        assert_eq!(decode("<p>日本語</p>".as_bytes(), None), "<p>日本語</p>");
        // 知らない名前は、UTF-8 で読む
        assert_eq!(
            decode("<p>日本語</p>".as_bytes(), Some("text/html; charset=bogus")),
            "<p>日本語</p>"
        );
        // UTF-16 と書かれていても、BOM がなければ UTF-8 で読む
        assert_eq!(
            decode(
                "<p>日本語</p>".as_bytes(),
                Some("text/html; charset=utf-16")
            ),
            "<p>日本語</p>"
        );
    }

    #[test]
    fn reports_pages_without_content() {
        let result = extract(
            b"<html><body></body></html>",
            Some("text/html"),
            "https://example.com/",
        );
        assert_eq!(result, Err(ExtractError::NoContent));
    }

    #[test]
    fn rejects_an_invalid_document_url() {
        let result = extract(page(&long_paragraphs()).as_bytes(), None, "not a url");
        assert!(matches!(result, Err(ExtractError::InvalidInput(_))));
    }
}
