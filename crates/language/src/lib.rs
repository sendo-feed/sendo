#![forbid(unsafe_code)]
//! 通信・DB に触れず、記事の自然文から主言語を判定する。

use std::sync::OnceLock;

use dom_query::Document;
use lingua::{LanguageDetector, LanguageDetectorBuilder};
use regex::Regex;
use sha2::{Digest, Sha256};

pub const DETECTOR: &str = "lingua-1.8.0-high-all75";
pub const PIPELINE_REVISION: u32 = 1;
const MAX_INPUT_BYTES: usize = 256 * 1024;
const SAMPLE_CHARS: usize = 2000;

#[derive(Debug, Clone)]
pub struct Detection {
    pub language: String,
    pub status: String,
    pub score: f64,
    pub margin: f64,
    pub input_hash: String,
}

fn prepared_text(html: &str) -> String {
    let doc = Document::from(html);
    doc.select("script,style,svg,math,pre,code,kbd,samp")
        .remove();
    let urls = URLS.get_or_init(|| Regex::new(r"https?://[^\s<>]+").unwrap());
    let formatted = doc.formatted_text();
    let without_urls = urls.replace_all(&formatted, " ");
    let normalized = without_urls
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let chars: Vec<_> = normalized.chars().collect();
    if chars.len() <= SAMPLE_CHARS {
        return normalized;
    }
    let chunk = SAMPLE_CHARS / 3;
    let middle = (chars.len() - chunk) / 2;
    [
        chars[..chunk].iter().collect::<String>(),
        chars[middle..middle + chunk].iter().collect(),
        chars[chars.len() - chunk..].iter().collect(),
    ]
    .join("\n")
}

static URLS: OnceLock<Regex> = OnceLock::new();
static DETECTOR_INSTANCE: OnceLock<LanguageDetector> = OnceLock::new();

pub fn detect(html: &str) -> Result<Detection, &'static str> {
    if html.len() > MAX_INPUT_BYTES {
        return Err("language input exceeds 256 KiB");
    }
    let text = prepared_text(html);
    // sha2 0.11 のダイジェストは `{:x}` で書けないので、1 バイトずつ 16 進にする
    let input_hash: String = Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut result = Detection {
        language: "und".into(),
        status: "insufficient".into(),
        score: 0.0,
        margin: 0.0,
        input_hash,
    };
    if text.chars().filter(|c| c.is_alphabetic()).count() < 40 {
        return Ok(result);
    }
    let detector =
        DETECTOR_INSTANCE.get_or_init(|| LanguageDetectorBuilder::from_all_languages().build());
    let scores = detector.compute_language_confidence_values(text);
    result.status = "uncertain".into();
    if let Some((language, score)) = scores.first() {
        result.score = *score;
        result.margin = score - scores.get(1).map_or(0.0, |(_, value)| *value);
        if result.score >= 0.8 && result.margin >= 0.2 {
            result.language = language.iso_code_639_1().to_string().to_lowercase();
            result.status = "detected".into();
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const JA: &str = "記事の言語を調べるときは、タイトルだけでなく本文も確認します。英語の製品名が含まれていても、日本語で書かれた説明文を英語の記事として扱わないことが大切です。判定が難しい場合は、結果を確定せずに保留します。";
    const EN: &str = "The application stores each article once and shares the original text across readers. A translation should be created only when the reader needs another language. The original article must remain available after translation.";

    #[test]
    fn prose_survives_code_and_url_noise() {
        let html = format!(
            "<p>{JA}</p><pre><code>{}</code></pre><script>{}</script><p>https://example.com/English</p>",
            EN.repeat(30),
            EN.repeat(10)
        );
        let result = detect(&html).unwrap();
        assert_eq!(result.language, "ja");
        assert_eq!(result.status, "detected");
        assert_eq!(result.input_hash, detect(JA).unwrap().input_hash);
        assert_eq!(detect(EN).unwrap().language, "en");
    }

    #[test]
    fn input_hash_is_lowercase_hex_sha256() {
        // 空の入力の SHA-256。保存済みのハッシュと比べるので、書き方を変えない
        assert_eq!(
            detect("").unwrap().input_hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn short_or_code_only_input_is_held_without_guessing() {
        for text in [
            "Rust",
            "Go",
            "AI",
            "続きを読む",
            "🙂🚀",
            "",
            "<pre>SELECT title FROM articles;</pre>",
        ] {
            let result = detect(text).unwrap();
            assert_eq!(result.language, "und");
            assert_eq!(result.status, "insufficient");
        }
    }

    #[test]
    fn long_unicode_prose_is_sampled_at_three_locations() {
        let text = "あ".repeat(4000) + &"い".repeat(4000) + &"う".repeat(4000);
        let sampled = prepared_text(&text);
        assert_eq!(sampled.chars().count(), 2000);
        let parts: Vec<_> = sampled.split('\n').collect();
        assert_eq!(
            parts,
            vec!["あ".repeat(666), "い".repeat(666), "う".repeat(666)]
        );
        assert_eq!(
            prepared_text("<p>first</p><p>second &amp; third</p>"),
            "first second & third"
        );
    }

    #[test]
    fn other_languages_are_not_forced_into_english_or_japanese() {
        let result = detect("La traduction automatique doit conserver les liens et les exemples de code. Le système commence par identifier la langue du texte avant de comparer le résultat avec les préférences de la personne.").unwrap();
        assert_eq!(result.language, "fr");
        assert!(detect(&"x".repeat(MAX_INPUT_BYTES + 1)).is_err());
    }
}
