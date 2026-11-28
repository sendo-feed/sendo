//! 記事から候補の語を抜く（記事の解析の 8〜11）。

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use crate::text::{ArticleText, truncate_at_word};

/// 記事あたりの候補の上限（記事の解析の 10）
pub const MAX_CANDIDATES: usize = 50;
/// フィードのカテゴリとして使う数の上限（記事の解析の 8）
pub const MAX_CATEGORIES: usize = 10;
/// 本文から語を拾う長さ（記事の解析の 8）
pub const BODY_CHARS: usize = 20_000;
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

/// 離れた版が名前の一部の語（記事の解析の 9）。まとめの鍵の形で持つ。語に直結したドット付きの版
/// （`Web2.0`）はいつも捨てるので、ここには空白で離れた形だけを置く
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

/// アクセント付きのラテン文字、ギリシャ文字、キリル文字。英数字の語のすぐ隣にあれば、その語は
/// 別の文字の語の一部なので拾わない（`Pokémon` から `Pok` を拾わない）
fn foreign_letter() -> &'static Regex {
    static LETTER: OnceLock<Regex> = OnceLock::new();
    LETTER.get_or_init(|| Regex::new(r"^[\p{Latin}\p{Greek}\p{Cyrillic}]$").expect("valid regex"))
}

fn is_foreign_letter(c: char) -> bool {
    !c.is_ascii() && foreign_letter().is_match(c.encode_utf8(&mut [0; 4]))
}

/// カタカナの語。カタカナと長音の並びで、`・` で区切る
fn katakana_words() -> &'static Regex {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    WORDS.get_or_init(|| Regex::new(r"[\p{Katakana}ー]{2,}").expect("valid regex"))
}

/// 版だけの語（`8`、`3.13`、`v20`）。大文字の `V`（`V8`）は名前なので版にしない
fn version_only() -> &'static Regex {
    static VERSION: OnceLock<Regex> = OnceLock::new();
    VERSION.get_or_init(|| Regex::new(r"^v?\d+(?:\.\d+)*$").expect("valid regex"))
}

/// 語の末尾の、ハイフンのあとの版と、直結したドット付きの版（記事の解析の 9）。残す部分は英数字で
/// 終わる（`OpenSSL_1.1` は `OpenSSL`）
fn trailing_version() -> &'static Regex {
    static VERSION: OnceLock<Regex> = OnceLock::new();
    VERSION.get_or_init(|| {
        Regex::new(r"^(\.?[A-Za-z0-9]*?[A-Za-z][A-Za-z0-9._\-]*?[A-Za-z0-9])[._\-]*(?:-v?\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)$")
            .expect("valid regex")
    })
}

/// カテゴリから落とす文字：制御文字、書式の文字（ゼロ幅スペースなど）、置き換えの文字（JS の対に
/// なっていないサロゲートは、napi で U+FFFD になって届く）
fn unwanted_characters() -> &'static Regex {
    static UNWANTED: OnceLock<Regex> = OnceLock::new();
    UNWANTED.get_or_init(|| Regex::new(r"[\p{Cc}\p{Cf}\x{FFFD}]").expect("valid regex"))
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
        && !key.chars().all(|c| c.is_numeric() || c == '.' || c == ' ')
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

/// 並びの途中の語と、その語の始まりの位置
struct RunWord {
    start: usize,
    word: String,
}

/// 英数字の語を、版を捨てながら読み、並びにまとめて候補にする。候補は始まりの位置と一緒に返す
fn ascii_candidates(text: &str, out: &mut Vec<(usize, String)>) {
    let tokens: Vec<(usize, usize)> = ascii_words()
        .find_iter(text)
        .map(|m| (m.start(), m.end()))
        .filter(|&(start, end)| {
            let before = text[..start].chars().next_back();
            let after = text[end..].chars().next();
            !before.is_some_and(is_foreign_letter) && !after.is_some_and(is_foreign_letter)
        })
        .collect();
    let mut run: Vec<RunWord> = Vec::new();
    for (i, &(start, end)) in tokens.iter().enumerate() {
        let raw = &text[start..end];
        let joined_to_previous = i > 0 && &text[tokens[i - 1].1..start] == " ";
        // 前の語との間が空白 1 つでなければ、並びを切る
        if !joined_to_previous {
            flush_run(&mut run, out);
        }

        // 版だけの語：直前の語とまとめて例外の一覧にあれば、版を残す。版は並びを切る
        if version_only().is_match(raw) {
            if let Some(previous) = run.last_mut().filter(|_| joined_to_previous) {
                let joined = format!("{} {raw}", previous.word);
                if VERSION_EXCEPTIONS.contains(&key_of(&joined).as_str()) {
                    previous.word = joined;
                }
            }
            flush_run(&mut run, out);
            continue;
        }

        let word = trailing_version()
            .captures(raw)
            .and_then(|captures| captures.get(1))
            .map_or(raw, |m| m.as_str());
        // 先頭だけ大文字の機能語（`In`、`The`）は並びに入れ、あとで並びの端から落とす
        let capitalized_function_word =
            is_function_word(word) && word.starts_with(|c: char| c.is_ascii_uppercase());
        if qualifies(word) || capitalized_function_word {
            run.push(RunWord {
                start,
                word: word.to_string(),
            });
        } else {
            flush_run(&mut run, out);
        }
    }
    flush_run(&mut run, out);
}

/// 並びの端の機能語を落としてから語の数を数え、2〜3 語なら 1 つの候補、4 語以上なら語ごとにする
fn flush_run(run: &mut Vec<RunWord>, out: &mut Vec<(usize, String)>) {
    let mut words: Vec<RunWord> = std::mem::take(run);
    while words.first().is_some_and(|w| is_function_word(&w.word)) {
        words.remove(0);
    }
    while words.last().is_some_and(|w| is_function_word(&w.word)) {
        words.pop();
    }
    match words.len() {
        0 => {}
        1..=3 => {
            let start = words[0].start;
            let joined = words
                .into_iter()
                .map(|w| w.word)
                .collect::<Vec<_>>()
                .join(" ");
            out.push((start, joined));
        }
        _ => out.extend(
            words
                .into_iter()
                .filter(|w| !is_function_word(&w.word))
                .map(|w| (w.start, w.word)),
        ),
    }
}

/// カタカナの語。先頭の長音は落とし、繰り返しの記号だけの語は拾わない
fn katakana_candidates(text: &str, out: &mut Vec<(usize, String)>) {
    for m in katakana_words().find_iter(text) {
        let trimmed = m.as_str().trim_start_matches('ー');
        let start = m.end() - trimmed.len();
        let meaningful = trimmed.chars().any(|c| !matches!(c, 'ー' | 'ヽ' | 'ヾ'));
        if meaningful {
            out.push((start, trimmed.to_string()));
        }
    }
}

/// フィードのカテゴリを、落とす文字を除き、前後の空白を除き、NFKC にそろえる（記事の解析の 8）
fn clean_category(category: &str) -> String {
    let cleaned = unwanted_characters().replace_all(category, "");
    let nfkc: String = cleaned.trim().nfkc().collect();
    nfkc.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 記事の候補の語を返す。`summary` は解析の入力に使う要約（同じフィードで同じ要約なら、呼ぶ側が
/// 空にして渡す）
pub fn extract(
    title: &str,
    summary: &str,
    body_html: &str,
    categories: &[String],
) -> Vec<Candidate> {
    extract_from(
        &ArticleText::from_html(title, summary, body_html),
        categories,
    )
}

/// 解析の入力から候補の語を返す
pub fn extract_from(text: &ArticleText, categories: &[String]) -> Vec<Candidate> {
    let mut found: Vec<(String, String, Source)> = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();

    // カテゴリは、掃除して決まりに合うものから 10 個まで
    let cleaned = categories
        .iter()
        .map(|category| {
            let surface = clean_category(category);
            let key = key_of(&surface);
            (surface, key)
        })
        .filter(|(surface, key)| acceptable(surface, key))
        .take(MAX_CATEGORIES);
    for (surface, key) in cleaned {
        *counts.entry(key.clone()).or_default() += 1;
        found.push((surface, key, Source::Category));
    }

    let joined = [
        text.title.as_str(),
        text.summary.as_str(),
        truncate_at_word(&text.body, BODY_CHARS),
    ]
    .join("\n");
    for line in joined.lines() {
        // 英数字の語とカタカナの語を、行の中で出てきた順に並べる
        let mut words: Vec<(usize, String)> = Vec::new();
        ascii_candidates(line, &mut words);
        katakana_candidates(line, &mut words);
        words.sort_by_key(|(start, _)| *start);
        for (_, surface) in words {
            let key = key_of(&surface);
            if acceptable(&surface, &key) {
                *counts.entry(key.clone()).or_default() += 1;
                found.push((surface, key, Source::Text));
            }
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
        let not_category = |c: &Candidate| c.source != Source::Category;
        not_category(a)
            .cmp(&not_category(b))
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
        let got = surfaces("Claude Code と k8s と C++ と C# と .NET と V8 の話");
        for want in ["Claude Code", "k8s", "C++", "C#", ".NET", "V8"] {
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
    fn leaves_no_trailing_symbols_after_dropping_versions() {
        assert_eq!(surfaces("OpenSSL_1.1"), vec!["OpenSSL"]);
        assert_eq!(surfaces("Xcode_15.2"), vec!["Xcode"]);
        assert_eq!(surfaces("Foo.1.2"), vec!["Foo"]);
        assert_eq!(surfaces("Bar--2"), vec!["Bar"]);
    }

    #[test]
    fn applies_the_order_version_then_case_then_dots() {
        assert_eq!(surfaces("iOS18.1"), vec!["iOS"]);
        assert!(surfaces("python3.13").is_empty());
        assert!(surfaces("document.addEventListener navigator.userAgent").is_empty());
        assert_eq!(surfaces("Node.js と ASP.NET"), vec!["Node.js", "ASP.NET"]);
    }

    #[test]
    fn skips_words_cut_by_accented_letters() {
        assert_eq!(surfaces("Pokémon GO と Café"), vec!["GO"]);
    }

    #[test]
    fn picks_katakana_words_split_at_middle_dots() {
        let got = surfaces("コンテナ・オーケストレーションの話");
        assert_eq!(got, vec!["コンテナ", "オーケストレーション"]);
    }

    #[test]
    fn trims_leading_long_vowels_and_skips_iteration_marks() {
        assert_eq!(surfaces("ーー テスト ーアイ ヽヽ"), vec!["テスト", "アイ"]);
    }

    #[test]
    fn keeps_the_order_of_appearance_within_a_line() {
        assert_eq!(
            surfaces("コンテナとDockerとKubernetes"),
            vec!["コンテナ", "Docker", "Kubernetes"]
        );
    }

    #[test]
    fn skips_digit_only_and_too_short_or_long_candidates() {
        assert!(surfaces("2024 R").is_empty());
        assert!(surfaces(&"A".repeat(41)).is_empty());
        assert_eq!(surfaces(&"A".repeat(40)), vec!["A".repeat(40)]);
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
    fn cleans_categories_before_taking_ten() {
        let mut categories: Vec<String> = vec![
            "٢٠٢٤".into(),
            "\u{200b}Go\u{200b}".into(),
            "Rust\u{FFFD}".into(),
        ];
        categories.extend((0..12).map(|i| format!("Tag{i:02}")));
        let got: Vec<String> = extract("", "", "", &categories)
            .into_iter()
            .map(|c| c.surface)
            .collect();
        assert_eq!(got.len(), MAX_CATEGORIES);
        assert_eq!(got[0], "Go");
        assert_eq!(got[1], "Rust");
        assert_eq!(got[9], "Tag07");
    }

    #[test]
    fn measures_both_surface_and_key_lengths_of_categories() {
        // 小文字にすると 2 倍の長さになる文字：表記は 30、鍵は 60 なので落とす
        let long_key = "İ".repeat(30);
        // NFKC で 1 文字が 4 文字になる文字
        let got = extract("", "", "", &[long_key, "㍿".to_string()]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].surface, "株式会社");
    }

    #[test]
    fn reads_the_body_up_to_20000_code_points_and_drops_the_cut_word() {
        let exact = format!("<p>{}Rust</p>", "あ".repeat(BODY_CHARS - 4));
        assert_eq!(keys("", &exact), vec!["rust"]);
        let cut_ascii = format!("<p>{}Kubernetes</p>", "あ".repeat(BODY_CHARS - 4));
        assert!(keys("", &cut_ascii).is_empty());
        let cut_katakana = format!("<p>{}コンテナ</p>", "あ".repeat(BODY_CHARS - 2));
        assert!(keys("", &cut_katakana).is_empty());
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
        assert_eq!(keys("", html), vec!["kubectl"]);
    }
}
