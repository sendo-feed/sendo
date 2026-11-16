//! sendo の Rust の処理を、napi-rs で Node から呼ぶための結び（docs/decisions/tech-stack.md の 5）。
//!
//! 読み込むのは src/platform/node/ だけ。重い処理は napi の非同期の仕事（AsyncTask）として、
//! libuv のスレッドプールで動かし、イベントループを止めない。panic はエラーにして JS に返し、
//! プロセスを落とさない。

use std::panic::{AssertUnwindSafe, catch_unwind};

use napi::bindgen_prelude::{AsyncTask, Uint8Array};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use sendo_extract::{ExtractError, Extracted};

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
