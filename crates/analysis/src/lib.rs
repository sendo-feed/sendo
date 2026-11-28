#![forbid(unsafe_code)]
//! 通信・DB・ファイルに触れず、記事から候補の語と埋め込みベクトルを作る
//! （docs/decisions/article-analysis.md）。モデルのファイルは緩衝層が読み、バイト列で受け取る。

pub mod candidates;
pub mod embed;
pub mod text;

pub use candidates::{
    Candidate, MAX_CANDIDATES, Source, extract as extract_candidates,
    extract_from as extract_candidates_from,
};
pub use embed::{DIMENSION, Embedder};
pub use text::ArticleText;

/// 候補の抜き方の版。抜き方（機能語の一覧、版の例外の一覧、拾い方）を変えたら上げる（記事の解析の 5）
pub const CANDIDATE_REVISION: u32 = 1;
/// 埋め込みの版。モデルか入力の作り方を変えたら上げる（記事の解析の 5）
pub const EMBEDDING_REVISION: u32 = 1;
