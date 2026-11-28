//! sendo の Rust の処理を、napi-rs で Node から呼ぶための結び（docs/decisions/tech-stack.md の 5）。
//!
//! 読み込むのは src/platform/node/ だけ。重い処理は napi の非同期の仕事（AsyncTask）として、
//! libuv のスレッドプールで動かし、イベントループを止めない。panic はエラーにして JS に返し、
//! プロセスを落とさない。

use std::panic::{AssertUnwindSafe, catch_unwind};

use napi::bindgen_prelude::{AsyncTask, Float32Array, Uint8Array};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use sendo_extract::{ExtractError, Extracted};

#[napi(object)]
pub struct LanguageDetectorInfo {
    pub detector: String,
    pub pipeline_revision: u32,
}

#[napi]
pub fn language_detector_info() -> LanguageDetectorInfo {
    LanguageDetectorInfo {
        detector: sendo_language::DETECTOR.into(),
        pipeline_revision: sendo_language::PIPELINE_REVISION,
    }
}

#[napi(object)]
pub struct ArticleLanguage {
    pub language: String,
    pub status: String,
    pub score: f64,
    pub margin: f64,
    pub input_hash: String,
}

pub struct LanguageTask {
    html: String,
}

impl Task for LanguageTask {
    type Output = sendo_language::Detection;
    type JsValue = ArticleLanguage;

    fn compute(&mut self) -> Result<Self::Output> {
        catch_unwind(AssertUnwindSafe(|| sendo_language::detect(&self.html)))
            .map_err(|_| Error::new(Status::GenericFailure, "language detection panicked"))?
            .map_err(|error| Error::new(Status::InvalidArg, error))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(ArticleLanguage {
            language: output.language,
            status: output.status,
            score: output.score,
            margin: output.margin,
            input_hash: output.input_hash,
        })
    }
}

#[napi]
pub fn detect_article_language(html: String) -> AsyncTask<LanguageTask> {
    AsyncTask::new(LanguageTask { html })
}

/// 記事のページから抜いた本文（サニタイズしていない HTML）
#[napi(object)]
pub struct ExtractedPage {
    pub title: String,
    pub html: String,
    pub text_length: u32,
}

pub struct ExtractTask {
    bytes: Vec<u8>,
    content_type: Option<String>,
    url: String,
}

impl Task for ExtractTask {
    type Output = Option<Extracted>;
    type JsValue = Option<ExtractedPage>;

    /// スレッドプールの上で動く。本文が見つからなければ None
    fn compute(&mut self) -> Result<Self::Output> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            sendo_extract::extract(&self.bytes, self.content_type.as_deref(), &self.url)
        }));
        match result {
            Ok(Ok(extracted)) => Ok(Some(extracted)),
            Ok(Err(ExtractError::NoContent)) => Ok(None),
            Ok(Err(error)) => Err(Error::new(Status::InvalidArg, error.to_string())),
            Err(_) => Err(Error::new(Status::GenericFailure, "extraction panicked")),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.map(|extracted| ExtractedPage {
            title: extracted.title,
            html: extracted.html,
            text_length: u32::try_from(extracted.text_length).unwrap_or(u32::MAX),
        }))
    }
}

/// 記事のページのバイト列から本文を抜く（docs/decisions/content.md の 12）。
/// 本文が見つからなければ null を返す
#[napi]
pub fn extract_page_content(
    bytes: Uint8Array,
    content_type: Option<String>,
    url: String,
) -> AsyncTask<ExtractTask> {
    AsyncTask::new(ExtractTask {
        bytes: bytes.to_vec(),
        content_type,
        url,
    })
}

#[napi(object)]
pub struct PageImageLink {
    pub thumbnail: String,
    pub target: String,
}

#[napi(object)]
#[derive(Default)]
pub struct MediaResult {
    pub links: Vec<PageImageLink>,
    pub candidates: Vec<String>,
    pub eligible: bool,
    pub matches: bool,
    pub html: String,
    pub lead: Vec<String>,
    pub later: Vec<String>,
}

enum MediaInput {
    Links {
        html: String,
        url: String,
    },
    Candidates {
        bytes: Vec<u8>,
        content_type: Option<String>,
        url: String,
    },
    Compare {
        thumbnail: Vec<u8>,
        candidate: Option<Vec<u8>>,
    },
    Replace {
        html: String,
        thumbnail: String,
        target: String,
        replacement: String,
    },
    Lead {
        html: String,
        url: String,
    },
    Same {
        image: Vec<u8>,
        other: Vec<u8>,
    },
    Remove {
        html: String,
        src: String,
        url: String,
    },
}

pub struct MediaTask {
    input: MediaInput,
}
impl Task for MediaTask {
    type Output = MediaResult;
    type JsValue = MediaResult;
    fn compute(&mut self) -> Result<Self::Output> {
        use sendo_extract::media;
        catch_unwind(AssertUnwindSafe(|| {
            let mut result = MediaResult::default();
            match &self.input {
                MediaInput::Links { html, url } => {
                    result.links = media::image_links(html, url)
                        .into_iter()
                        .map(|link| PageImageLink {
                            thumbnail: link.thumbnail,
                            target: link.target,
                        })
                        .collect()
                }
                MediaInput::Candidates {
                    bytes,
                    content_type,
                    url,
                } => {
                    result.candidates = media::image_candidates(bytes, content_type.as_deref(), url)
                }
                MediaInput::Compare {
                    thumbnail,
                    candidate,
                } => {
                    result.eligible = media::eligible_thumbnail(thumbnail);
                    result.matches = candidate
                        .as_ref()
                        .is_some_and(|candidate| media::is_larger_image(thumbnail, candidate));
                }
                MediaInput::Replace {
                    html,
                    thumbnail,
                    target,
                    replacement,
                } => result.html = media::replace_image(html, thumbnail, target, replacement),
                MediaInput::Lead { html, url } => {
                    let images = media::lead_images(html, url);
                    result.lead = images.lead;
                    result.later = images.later;
                }
                MediaInput::Same { image, other } => {
                    result.matches = media::is_same_picture(image, other);
                }
                MediaInput::Remove { html, src, url } => {
                    result.html = media::remove_image(html, src, url);
                }
            }
            result
        }))
        .map_err(|_| Error::new(Status::GenericFailure, "image processing panicked"))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn page_image_links(html: String, url: String) -> AsyncTask<MediaTask> {
    AsyncTask::new(MediaTask {
        input: MediaInput::Links { html, url },
    })
}
#[napi]
pub fn page_image_candidates(
    bytes: Uint8Array,
    content_type: Option<String>,
    url: String,
) -> AsyncTask<MediaTask> {
    AsyncTask::new(MediaTask {
        input: MediaInput::Candidates {
            bytes: bytes.to_vec(),
            content_type,
            url,
        },
    })
}
#[napi]
pub fn compare_page_images(
    thumbnail: Uint8Array,
    candidate: Option<Uint8Array>,
) -> AsyncTask<MediaTask> {
    AsyncTask::new(MediaTask {
        input: MediaInput::Compare {
            thumbnail: thumbnail.to_vec(),
            candidate: candidate.map(|bytes| bytes.to_vec()),
        },
    })
}
#[napi]
pub fn replace_page_image(
    html: String,
    thumbnail: String,
    target: String,
    replacement: String,
) -> AsyncTask<MediaTask> {
    AsyncTask::new(MediaTask {
        input: MediaInput::Replace {
            html,
            thumbnail,
            target,
            replacement,
        },
    })
}
/// 導入の画像と、そのあとの画像の URL（docs/decisions/content.md の 21）
#[napi]
pub fn page_lead_images(html: String, url: String) -> AsyncTask<MediaTask> {
    AsyncTask::new(MediaTask {
        input: MediaInput::Lead { html, url },
    })
}
/// 縁の帯を除いてから、同じ写真かを見る（結果は matches）
#[napi]
pub fn same_page_images(image: Uint8Array, other: Uint8Array) -> AsyncTask<MediaTask> {
    AsyncTask::new(MediaTask {
        input: MediaInput::Same {
            image: image.to_vec(),
            other: other.to_vec(),
        },
    })
}
/// 導入の画像を 1 枚落とす
#[napi]
pub fn remove_page_image(html: String, src: String, url: String) -> AsyncTask<MediaTask> {
    AsyncTask::new(MediaTask {
        input: MediaInput::Remove { html, src, url },
    })
}

/// 記事の解析の版と、埋め込みの次元（docs/decisions/article-analysis.md の 5）
#[napi(object)]
pub struct AnalysisInfo {
    pub candidate_revision: u32,
    pub embedding_revision: u32,
    pub dimension: u32,
}

#[napi]
pub fn analysis_info() -> AnalysisInfo {
    AnalysisInfo {
        candidate_revision: sendo_analysis::CANDIDATE_REVISION,
        embedding_revision: sendo_analysis::EMBEDDING_REVISION,
        dimension: sendo_analysis::DIMENSION as u32,
    }
}

/// 起動時に読み込んだ埋め込みのモデル。プロセスの中で 1 つだけ持ち、スレッドで共有する
static EMBEDDER: std::sync::OnceLock<sendo_analysis::Embedder> = std::sync::OnceLock::new();

fn embedder() -> Result<&'static sendo_analysis::Embedder> {
    EMBEDDER
        .get()
        .ok_or_else(|| Error::new(Status::GenericFailure, "the embedding model is not loaded"))
}

/// JS のバイト列をそのまま持つ（130MB のモデルを写さず、読み込み中の最大のメモリを抑えるため）
pub struct LoadModelTask {
    tokenizer: Uint8Array,
    model: Uint8Array,
    config: Uint8Array,
}

impl Task for LoadModelTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        if EMBEDDER.get().is_some() {
            return Ok(());
        }
        let embedder = catch_unwind(AssertUnwindSafe(|| {
            sendo_analysis::Embedder::from_bytes(&self.tokenizer, &self.model, &self.config)
        }))
        .map_err(|_| {
            Error::new(
                Status::GenericFailure,
                "loading the embedding model panicked",
            )
        })?
        .map_err(|error| Error::new(Status::InvalidArg, error))?;
        // 同時に 2 回呼ばれても、先に入ったほうを使う
        let _ = EMBEDDER.set(embedder);
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

/// 緩衝層が読んだモデルのファイルのバイト列から、埋め込みのモデルを読み込む（記事の解析の 6）。
/// 2 回目からは何もしない
#[napi]
pub fn load_embedding_model(
    tokenizer: Uint8Array,
    model: Uint8Array,
    config: Uint8Array,
) -> AsyncTask<LoadModelTask> {
    AsyncTask::new(LoadModelTask {
        tokenizer,
        model,
        config,
    })
}

#[napi(object)]
pub struct ArticleAnalysisInput {
    pub title: String,
    /// 解析の入力に使う要約。同じフィードで同じ要約なら、呼ぶ側が空にする（記事の解析の 8）
    pub summary: String,
    /// 抜いた本文（なければフィードの本文）の HTML
    pub html: String,
    pub categories: Vec<String>,
    pub candidates: bool,
    pub embedding: bool,
}

#[napi(object)]
pub struct AnalysisCandidate {
    pub surface: String,
    pub key: String,
    /// `category` か `text`
    pub source: String,
}

#[napi(object)]
pub struct ArticleAnalysisOutput {
    /// 候補を求めたときだけ
    pub candidates: Option<Vec<AnalysisCandidate>>,
    /// 埋め込みを求めたときだけ。入力が空なら null
    pub embedding: Option<Float32Array>,
}

pub struct AnalyzeTask {
    input: ArticleAnalysisInput,
}

pub struct AnalyzeResult {
    candidates: Option<Vec<sendo_analysis::Candidate>>,
    embedding: Option<Vec<f32>>,
}

impl Task for AnalyzeTask {
    type Output = AnalyzeResult;
    type JsValue = ArticleAnalysisOutput;

    fn compute(&mut self) -> Result<Self::Output> {
        let input = &self.input;
        if input.html.len() > sendo_analysis::text::MAX_INPUT_BYTES {
            return Err(Error::new(
                Status::InvalidArg,
                "analysis input exceeds 512 KiB",
            ));
        }
        let embedder = if input.embedding {
            Some(embedder()?)
        } else {
            None
        };
        catch_unwind(AssertUnwindSafe(|| AnalyzeResult {
            candidates: input.candidates.then(|| {
                sendo_analysis::extract_candidates(
                    &input.title,
                    &input.summary,
                    &input.html,
                    &input.categories,
                )
            }),
            embedding: embedder
                .and_then(|e| e.embed_article(&input.title, &input.summary, &input.html)),
        }))
        .map_err(|_| Error::new(Status::GenericFailure, "article analysis panicked"))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(ArticleAnalysisOutput {
            candidates: output.candidates.map(|candidates| {
                candidates
                    .into_iter()
                    .map(|c| AnalysisCandidate {
                        surface: c.surface,
                        key: c.key,
                        source: c.source.as_str().into(),
                    })
                    .collect()
            }),
            embedding: output.embedding.map(Float32Array::new),
        })
    }
}

/// 記事から候補の語と埋め込みを作る（docs/decisions/article-analysis.md の 7〜11）
#[napi]
pub fn analyze_article(input: ArticleAnalysisInput) -> AsyncTask<AnalyzeTask> {
    AsyncTask::new(AnalyzeTask { input })
}

pub struct EmbedTextTask {
    text: String,
}

impl Task for EmbedTextTask {
    type Output = Option<Vec<f32>>;
    type JsValue = Option<Float32Array>;

    fn compute(&mut self) -> Result<Self::Output> {
        let embedder = embedder()?;
        catch_unwind(AssertUnwindSafe(|| embedder.embed_text(&self.text)))
            .map_err(|_| Error::new(Status::GenericFailure, "text embedding panicked"))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.map(Float32Array::new))
    }
}

/// 文の埋め込み（タグの名前と説明など）。空なら null
#[napi]
pub fn embed_text(text: String) -> AsyncTask<EmbedTextTask> {
    AsyncTask::new(EmbedTextTask { text })
}
