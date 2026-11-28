//! 記事と文の埋め込みベクトルを作る（記事の解析の 6、7）。

use model2vec_rs::model::StaticModel;

use crate::text::{ArticleText, normalize, truncate_chars};

/// 埋め込みの次元（potion-multilingual-128M）
pub const DIMENSION: usize = 256;
/// トークンにする前に切る長さ（記事の解析の 7）
const INPUT_CHARS: usize = 2_000;
/// トークンで切る長さ。決定の計測と同じ（model2vec の既定の max_length）
const MAX_TOKENS: usize = 512;

/// 埋め込みのモデル。読み込んだら、ほかのスレッドと共有して使う
pub struct Embedder {
    model: StaticModel,
}

impl Embedder {
    /// 緩衝層が読んだ `tokenizer.json`、`model.safetensors`（行ごとの int8 と倍率）、`config.json` の
    /// バイト列から作る。Rust の側はファイルを読まない
    pub fn from_bytes(tokenizer: &[u8], model: &[u8], config: &[u8]) -> Result<Self, String> {
        let model = StaticModel::from_bytes(tokenizer, model, config, None)
            .map_err(|error| format!("could not load the embedding model: {error:#}"))?;
        if model.dim() != DIMENSION {
            return Err(format!(
                "unexpected embedding dimension: {} (expected {DIMENSION})",
                model.dim()
            ));
        }
        Ok(Embedder { model })
    }

    /// 記事の埋め込み。入力（タイトル、要約、本文）が空なら None（「入力が空」）
    pub fn embed_article(&self, title: &str, summary: &str, body_html: &str) -> Option<Vec<f32>> {
        self.embed_prepared(&ArticleText::from_html(title, summary, body_html))
    }

    /// 解析の入力から記事の埋め込みを作る。候補の語と同じ入力を使い、HTML を 2 回解析しない
    pub fn embed_prepared(&self, text: &ArticleText) -> Option<Vec<f32>> {
        self.encode(&article_input(text))
    }

    /// 文の埋め込み（タグの名前と説明など）。空なら None
    pub fn embed_text(&self, text: &str) -> Option<Vec<f32>> {
        self.encode(truncate_chars(&normalize(text), INPUT_CHARS))
    }

    fn encode(&self, text: &str) -> Option<Vec<f32>> {
        if text.trim().is_empty() {
            return None;
        }
        // 判定はベクトルの内積を cosine として使うので、モデルの設定によらず長さを 1 にそろえる
        let vectors =
            self.model
                .encode_with_args(&[text.to_string()], Some(MAX_TOKENS), 1, Some(true));
        let vector = vectors.into_iter().next()?;
        if vector.iter().all(|value| *value == 0.0) {
            return None;
        }
        Some(vector)
    }
}

/// 埋め込みの入力：タイトル、要約、本文のプレーンテキストを、先頭 2,000 コードポイントで切る
pub fn article_input(text: &ArticleText) -> String {
    let joined = [
        text.title.as_str(),
        text.summary.as_str(),
        text.body.as_str(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    truncate_chars(&joined, INPUT_CHARS).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn article_input_joins_parts_and_cuts_at_2000_code_points() {
        let body = format!("<p>{}</p><pre>code</pre>", "あ".repeat(3000));
        let input = article_input(&ArticleText::from_html("Title", "<b>要約</b>", &body));
        assert!(input.starts_with("Title\n要約\nあ"));
        assert_eq!(input.chars().count(), 2000);
        assert!(!input.contains("code"));
    }

    #[test]
    fn article_input_is_empty_without_text() {
        assert_eq!(
            article_input(&ArticleText::from_html("", "", "<pre>only code</pre>")),
            ""
        );
    }
}

#[cfg(test)]
pub(crate) mod tiny_model {
    //! テスト用の小さなモデル。本物と同じ形（行ごとの int8 と倍率の `weights`）のファイルを組み立てる

    pub const DIM: usize = 4;

    pub fn tokenizer() -> Vec<u8> {
        let vocab = r#"{"[UNK]":0,"rust":1,"code":2,"apple":3,"mac":4}"#;
        format!(
            r#"{{"version":"1.0","truncation":null,"padding":null,"added_tokens":[],"normalizer":{{"type":"Lowercase"}},"pre_tokenizer":{{"type":"Whitespace"}},"post_processor":null,"decoder":null,"model":{{"type":"WordLevel","vocab":{vocab},"unk_token":"[UNK]"}}}}"#
        )
        .into_bytes()
    }

    /// 行ごとに int8 の表と倍率を持つ safetensors
    pub fn model(dim: usize) -> Vec<u8> {
        let rows: [[i8; 4]; 5] = [
            [0, 0, 0, 0],
            [127, 0, 0, 0],
            [100, 50, 0, 0],
            [0, 0, 127, 0],
            [0, 0, 90, 60],
        ];
        let mut data: Vec<u8> = Vec::new();
        for row in rows {
            for value in row.iter().take(dim) {
                data.push(*value as u8);
            }
        }
        let weights: Vec<u8> = [0.01f32, 0.02, 0.02, 0.02, 0.02]
            .iter()
            .flat_map(|w| w.to_le_bytes())
            .collect();
        let header = format!(
            r#"{{"embeddings":{{"dtype":"I8","shape":[5,{dim}],"data_offsets":[0,{}]}},"weights":{{"dtype":"F32","shape":[5],"data_offsets":[{},{}]}}}}"#,
            data.len(),
            data.len(),
            data.len() + weights.len()
        );
        let mut header = header.into_bytes();
        while header.len() % 8 != 0 {
            header.push(b' ');
        }
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        bytes.extend(data);
        bytes.extend(weights);
        bytes
    }

    pub fn config() -> Vec<u8> {
        // 長さをそろえない設定でも、埋め込みは長さ 1 になる
        br#"{"model_type":"model2vec","hidden_dim":4,"normalize":false}"#.to_vec()
    }
}

#[cfg(test)]
mod model_tests {
    use super::tiny_model::*;
    use super::*;

    fn embedder() -> Embedder {
        let model = StaticModel::from_bytes(tokenizer(), model(DIM), config(), None).unwrap();
        Embedder { model }
    }

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn rejects_a_model_with_an_unexpected_dimension() {
        let error = Embedder::from_bytes(&tokenizer(), &model(DIM), &config())
            .err()
            .unwrap();
        assert!(
            error.contains("unexpected embedding dimension: 4"),
            "{error}"
        );
    }

    #[test]
    fn rejects_broken_model_bytes() {
        assert!(Embedder::from_bytes(&tokenizer(), b"broken", &config()).is_err());
    }

    #[test]
    fn embeds_articles_as_normalized_vectors_that_reflect_the_words() {
        let embedder = embedder();
        let rust = embedder.embed_article("Rust", "", "<p>code</p>").unwrap();
        let apple = embedder.embed_text("Apple Mac").unwrap();
        let norm: f32 = rust.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
        assert!(cosine(&rust, &embedder.embed_text("rust").unwrap()) > 0.9);
        assert!(cosine(&rust, &apple) < 0.1);
    }

    #[test]
    fn returns_none_for_empty_or_unknown_input() {
        let embedder = embedder();
        assert!(embedder.embed_article("", "", "<pre>rust</pre>").is_none());
        assert!(embedder.embed_text("   ").is_none());
        assert!(embedder.embed_text("unknown words").is_none());
    }
}
