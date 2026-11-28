//! 記事から候補の語を抜く（記事の解析の 8〜11）。

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use crate::text::{normalize, plain_text, truncate_at_word};

/// 記事あたりの候補の上限（記事の解析の 10）
pub const MAX_CANDIDATES: usize = 50;
/// フィードのカテゴリとして見る数の上限（記事の解析の 8）
pub const MAX_CATEGORIES: usize = 10;
/// 本文から語を拾う長さ（記事の解析の 8）
const BODY_CHARS: usize = 20_000;
const MIN_CHARS: usize = 2;
const MAX_CHARS: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// フィードのカテゴリ
    Category,
    /// 記事の文字
    Text,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Category => "category",
            Source::Text => "text",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// 表記（NFKC のあと）
    pub surface: String,
    /// まとめの鍵（記事の解析の 11）
    pub key: String,
    pub source: Source,
}

/// 冠詞・前置詞・代名詞・接続詞・助動詞・指示語などの機能語（閉じた語類。記事の解析の 9）。
/// 小文字の形で持ち、表記の小文字の形と、先頭だけ大文字の形にだけ当てる
const FUNCTION_WORDS: &[&str] = &[
    "a", "an", "the", "this", "that", "these", "those", "all", "any", "some", "each", "every",
    "no", "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his", "she", "her",
    "it", "its", "they", "them", "their", "who", "whom", "whose", "what", "which", "when", "where",
    "why", "how", "in", "on", "at", "of", "to", "for", "from", "by", "with", "about", "as", "into",
    "onto", "over", "under", "after", "before", "between", "through", "during", "without",
    "within", "via", "per", "and", "or", "but", "nor", "so", "yet", "if", "while", "because",
    "although", "though", "however", "also", "then", "than", "is", "are", "was", "were", "be",
    "been", "being", "am", "do", "does", "did", "have", "has", "had", "will", "would", "can",
    "could", "may", "might", "must", "shall", "should", "not", "there", "here",
];

/// 離れた版が名前の一部の語（記事の解析の 9）。まとめの鍵の形で持つ
const VERSION_EXCEPTIONS: &[&str] = &["web 2.0", "web 3.0", "industry 4.0", "society 5.0"];

fn is_function_word(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    if !FUNCTION_WORDS.contains(&lower.as_str()) {
        return false;
    }
    let mut capitalized = String::with_capacity(lower.len());
    let mut chars = lower.chars();
    if let Some(first) = chars.next() {
        capitalized.extend(first.to_uppercase());
        capitalized.push_str(chars.as_str());
    }
    word == lower || word == capitalized
}

/// 英数字の語。中の `.` `-` `_`、末尾の `+` `#`、英字の前の `.` を含める（記事の解析の 9）
fn ascii_words() -> &'static Regex {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    WORDS.get_or_init(|| {
        Regex::new(r"\.?[A-Za-z0-9](?:[A-Za-z0-9._\-]*[A-Za-z0-9])?(?:\+\+|\+|#)?")
            .expect("valid regex")
    })
}

/// カタカナの語。カタカナと長音の並びで、`・` で区切る
fn katakana_words() -> &'static Regex {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    WORDS.get_or_init(|| Regex::new(r"[\p{Katakana}ー]{2,}").expect("valid regex"))
}

/// 版だけの語（`8`、`3.13`、`v20`）
fn version_only() -> &'static Regex {
    static VERSION: OnceLock<Regex> = OnceLock::new();
    VERSION.get_or_init(|| Regex::new(r"^[vV]?\d+(?:\.\d+)*$").expect("valid regex"))
}

/// 語の末尾の、ハイフンのあとの版と、直結したドット付きの版（記事の解析の 9）
fn trailing_version() -> &'static Regex {
    static VERSION: OnceLock<Regex> = OnceLock::new();
    VERSION.get_or_init(|| {
        Regex::new(r"^(.*?[A-Za-z].*?)(?:-[vV]?\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)$")
            .expect("valid regex")
    })
}

/// まとめの鍵：NFKC、小文字、前後の空白を除き、空白を 1 つにそろえる（記事の解析の 11）
pub fn key_of(surface: &str) -> String {
    let nfkc: String = surface.nfkc().collect();
    nfkc.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 表記と鍵のどちらも 2〜40 コードポイントで、数字だけでない（記事の解析の 9）
fn acceptable(surface: &str, key: &str) -> bool {
    let surface_len = surface.chars().count();
    let key_len = key.chars().count();
    (MIN_CHARS..=MAX_CHARS).contains(&surface_len)
        && (MIN_CHARS..=MAX_CHARS).contains(&key_len)
        && !key
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ' ')
}

/// 版を捨てたあとの英数字の語が、拾う語か（記事の解析の 9 の判定の順番）
fn qualifies(word: &str) -> bool {
    let has_letter = word.chars().any(|c| c.is_ascii_alphabetic());
    let has_upper_or_digit = word
        .chars()
        .any(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !has_letter || !has_upper_or_digit {
        return false;
    }
    // 最初の文字が英小文字で、ドットでつながった語は、本文に紛れたコード
    let dotted_lowercase = word.starts_with(|c: char| c.is_ascii_lowercase()) && word.contains('.');
    if dotted_lowercase {
        return false;
    }
    !is_function_word(word)
}

/// 英数字の語を、版を捨てながら読み、並びにまとめて候補にする
fn ascii_candidates(text: &str, out: &mut Vec<String>) {
    let tokens: Vec<(usize, usize)> = ascii_words()
        .find_iter(text)
        .map(|m| (m.start(), m.end()))
        .collect();
    let mut run: Vec<String> = Vec::new();
    let mut last_end: Option<usize> = None;
    let mut i = 0;
    while i < tokens.len() {
        let (start, end) = tokens[i];
        let raw = &text[start..end];
        // 前の語との間が空白 1 つでなければ、並びを切る
        if last_end.is_some_and(|e| &text[e..start] != " ") {
            flush_run(&mut run, out);
        }
        last_end = Some(end);

        // 版だけの語：直前の語とまとめて例外の一覧にあれば、版を残す
        if version_only().is_match(raw) {
            if let Some(previous) = run.last_mut()
                && i > 0
                && &text[tokens[i - 1].1..start] == " "
            {
                let joined = format!("{previous} {raw}");
                if VERSION_EXCEPTIONS.contains(&key_of(&joined).as_str()) {
                    *previous = joined;
                }
            }
            // 版は並びを切る（版だけの語は拾わない）
            flush_run(&mut run, out);
            i += 1;
            continue;
        }

        let word = match trailing_version().captures(raw) {
            Some(captures) if !VERSION_EXCEPTIONS.contains(&key_of(raw).as_str()) => {
                captures.get(1).map_or(raw, |m| m.as_str())
            }
            _ => raw,
        };
        // 先頭だけ大文字の機能語（`In`、`The`）は並びに入れ、あとで並びの端から落とす
        let capitalized_function_word =
            is_function_word(word) && word.starts_with(|c: char| c.is_ascii_uppercase());
        if qualifies(word) || capitalized_function_word {
            run.push(word.to_string());
        } else {
            flush_run(&mut run, out);
        }
        i += 1;
    }
    flush_run(&mut run, out);
}

/// 並びの端の機能語を落としてから語の数を数え、2〜3 語なら 1 つの候補、4 語以上なら語ごとにする
fn flush_run(run: &mut Vec<String>, out: &mut Vec<String>) {
    let mut words: Vec<String> = std::mem::take(run);
    while words.first().is_some_and(|w| is_function_word(w)) {
        words.remove(0);
    }
    while words.last().is_some_and(|w| is_function_word(w)) {
        words.pop();
    }
    match words.len() {
        0 => {}
        1..=3 => out.push(words.join(" ")),
        _ => out.extend(words.into_iter().filter(|w| !is_function_word(w))),
    }
}

fn katakana_candidates(text: &str, out: &mut Vec<String>) {
    out.extend(
        katakana_words()
            .find_iter(text)
            .map(|m| m.as_str())
            .filter(|w| !w.chars().all(|c| c == 'ー'))
            .map(str::to_string),
    );
}

/// フィードのカテゴリを、制御文字を落とし、前後の空白を除き、NFKC にそろえる（記事の解析の 8）
fn clean_category(category: &str) -> String {
    let cleaned: String = category.chars().filter(|c| !c.is_control()).collect();
    let nfkc: String = cleaned.trim().nfkc().collect();
    nfkc.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 記事の候補の語を返す。`body_html` は抜いた本文（なければフィードの本文）。`summary` は
/// 解析の入力に使う要約（同じフィードで同じ要約なら、呼ぶ側が空にして渡す）
pub fn extract(
    title: &str,
    summary: &str,
    body_html: &str,
    categories: &[String],
) -> Vec<Candidate> {
    let mut found: Vec<(String, String, Source)> = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();

    for category in categories.iter().take(MAX_CATEGORIES) {
        let surface = clean_category(category);
        let key = key_of(&surface);
        if acceptable(&surface, &key) {
            *counts.entry(key.clone()).or_default() += 1;
            found.push((surface, key, Source::Category));
        }
    }

    let body = plain_text(body_html);
    let text = [
        normalize(title),
        plain_text(summary),
        truncate_at_word(&body, BODY_CHARS).to_string(),
    ]
    .join("\n");
    let mut words = Vec::new();
    for line in text.lines() {
        ascii_candidates(line, &mut words);
        katakana_candidates(line, &mut words);
    }
    for surface in words {
        let key = key_of(&surface);
        if acceptable(&surface, &key) {
            *counts.entry(key.clone()).or_default() += 1;
            found.push((surface, key, Source::Text));
        }
    }

    // 鍵で重なりを除く。表記は先に出たものを残し、カテゴリと記事の文字の両方にあれば出どころはカテゴリ
    let mut order: Vec<String> = Vec::new();
    let mut chosen: HashMap<String, Candidate> = HashMap::new();
    for (surface, key, source) in found {
        match chosen.get_mut(&key) {
            Some(existing) => {
                if source == Source::Category {
                    existing.source = Source::Category;
                }
            }
            None => {
                order.push(key.clone());
                chosen.insert(
                    key.clone(),
                    Candidate {
                        surface,
                        key,
                        source,
                    },
                );
            }
        }
    }

    // カテゴリ、記事の中で出た回数の多い順、先に出た順で、50 個まで選ぶ
    let mut ranked: Vec<(usize, Candidate)> = order
        .into_iter()
        .enumerate()
        .filter_map(|(index, key)| chosen.remove(&key).map(|c| (index, c)))
        .collect();
    ranked.sort_by(|(ia, a), (ib, b)| {
        let category = |c: &Candidate| c.source != Source::Category;
        category(a)
            .cmp(&category(b))
            .then_with(|| counts[&b.key].cmp(&counts[&a.key]))
            .then_with(|| ia.cmp(ib))
    });
    ranked
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|(_, c)| c)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(title: &str, body: &str) -> Vec<String> {
        extract(title, "", body, &[])
            .into_iter()
            .map(|c| c.key)
            .collect()
    }

    fn surfaces(title: &str) -> Vec<String> {
        extract(title, "", "", &[])
            .into_iter()
            .map(|c| c.surface)
            .collect()
    }

    #[test]
    fn picks_ascii_words_with_upper_or_digit_and_symbols() {
        let got = surfaces("Claude Code と k8s と C++ と C# と .NET の話");
        for want in ["Claude Code", "k8s", "C++", "C#", ".NET"] {
            assert!(got.contains(&want.to_string()), "{want} not in {got:?}");
        }
    }

    #[test]
    fn skips_lowercase_only_words_and_function_words() {
        let got = surfaces("the quick fox. The");
        assert!(got.is_empty(), "{got:?}");
    }

    #[test]
    fn drops_function_words_at_run_edges_before_counting() {
        assert_eq!(surfaces("In Rust"), vec!["Rust"]);
        assert_eq!(
            surfaces("The Visual Studio Code"),
            vec!["Visual Studio Code"]
        );
    }

    #[test]
    fn splits_runs_of_four_or_more_words() {
        let got = surfaces("How I Built A Tiny Linux Distro");
        assert!(got.contains(&"Built".to_string()), "{got:?}");
        assert!(got.contains(&"Linux".to_string()), "{got:?}");
        assert!(!got.iter().any(|s| s.contains(' ')), "{got:?}");
    }

    #[test]
    fn keeps_all_caps_words_that_look_like_function_words() {
        let got = surfaces("IT エンジニアと CAN バス");
        assert!(got.contains(&"IT".to_string()), "{got:?}");
        assert!(got.contains(&"CAN".to_string()), "{got:?}");
    }

    #[test]
    fn drops_versions_but_keeps_attached_integers() {
        assert_eq!(surfaces("Java 8"), vec!["Java"]);
        assert_eq!(surfaces("Java-8"), vec!["Java"]);
        assert_eq!(surfaces("Python3.13"), vec!["Python"]);
        assert_eq!(surfaces("Node v20"), vec!["Node"]);
        assert_eq!(surfaces("EC2"), vec!["EC2"]);
        assert_eq!(surfaces("Web3"), vec!["Web3"]);
        assert_eq!(surfaces("Java8"), vec!["Java8"]);
        assert_eq!(surfaces("Web 2.0"), vec!["Web 2.0"]);
    }

    #[test]
    fn applies_the_order_version_then_case_then_dots() {
        assert_eq!(surfaces("iOS18.1"), vec!["iOS"]);
        assert!(surfaces("python3.13").is_empty());
        assert!(surfaces("document.addEventListener navigator.userAgent").is_empty());
        assert_eq!(surfaces("Node.js と ASP.NET"), vec!["Node.js", "ASP.NET"]);
    }

    #[test]
    fn picks_katakana_words_split_at_middle_dots() {
        let got = surfaces("コンテナ・オーケストレーションの話");
        assert_eq!(got, vec!["コンテナ", "オーケストレーション"]);
    }

    #[test]
    fn skips_digit_only_and_too_short_or_long_candidates() {
        assert!(surfaces("2024 R").is_empty());
        let long = "A".repeat(41);
        assert!(surfaces(&long).is_empty());
    }

    #[test]
    fn makes_keys_with_nfkc_lowercase_and_single_spaces() {
        assert_eq!(key_of("ＡＷＳ"), "aws");
        assert_eq!(key_of("  Claude   Code "), "claude code");
        assert_eq!(keys("Kubernetes と KUBERNETES", ""), vec!["kubernetes"]);
    }

    #[test]
    fn uses_categories_first_and_prefers_category_as_source() {
        let categories = vec![
            "Rust".to_string(),
            " 2024 ".to_string(),
            "\u{7}AWS ".to_string(),
        ];
        let got = extract("Rust と Go", "", "", &categories);
        assert_eq!(got[0].surface, "Rust");
        assert_eq!(got[0].source, Source::Category);
        assert_eq!(got[1].surface, "AWS");
        assert!(got.iter().all(|c| c.key != "2024"));
    }

    #[test]
    fn ranks_text_candidates_by_count_then_first_appearance_and_caps_at_50() {
        let body: String = (0..60)
            .map(|i| format!("<p>Term{i:02}</p>"))
            .collect::<String>()
            + "<p>Rust</p><p>Rust</p><p>Rust</p>";
        let got = extract("", "", &body, &[]);
        assert_eq!(got.len(), MAX_CANDIDATES);
        assert_eq!(got[0].surface, "Rust");
        assert_eq!(got[1].surface, "Term00");
    }

    #[test]
    fn drops_code_blocks_and_urls_from_the_body() {
        let html = "<p>使うのは <code>Kubectl</code></p><pre>GetElement Foo</pre><p>https://Example.com/X</p>";
        let got = keys("", html);
        assert_eq!(got, vec!["kubectl"]);
    }
}
