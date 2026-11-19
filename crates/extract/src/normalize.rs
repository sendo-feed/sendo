//! 遅延画像と srcset を、位置・リンクを保ったまま img.src にそろえる。
use std::collections::HashMap;

use dom_query::{Document, NodeId, Selection};
use url::Url;

pub(crate) fn http(value: &str, base: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('#') {
        return None;
    }
    let url = Url::parse(base).ok()?.join(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.into())
}
pub(crate) fn srcset(value: &str, base: &str) -> Vec<(String, f64, char)> {
    let chars: Vec<char> = value.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        while i < chars.len() && (chars[i].is_ascii_whitespace() || chars[i] == ',') {
            i += 1
        }
        let start = i;
        while i < chars.len() && !chars[i].is_ascii_whitespace() {
            i += 1
        }
        if start == i {
            break;
        }
        let token: String = chars[start..i].iter().collect();
        let had_comma = token.ends_with(',');
        let token = token.trim_end_matches(',');
        let mut descriptor = String::new();
        if !had_comma {
            let mut depth = 0;
            while i < chars.len() {
                let c = chars[i];
                i += 1;
                if c == ',' && depth == 0 {
                    break;
                }
                if c == '(' {
                    depth += 1
                }
                if c == ')' {
                    depth -= 1
                }
                descriptor.push(c)
            }
        }
        let Some(url) = http(token, base) else {
            continue;
        };
        let ds: Vec<_> = descriptor.split_whitespace().collect();
        let (score, unit) = match ds.as_slice() {
            [] => (1.0, 'x'),
            [d] if d.ends_with('w') => match d[..d.len() - 1].parse::<u32>() {
                Ok(n) if n > 0 => (n as f64, 'w'),
                _ => continue,
            },
            [d] if d.ends_with('x') => match d[..d.len() - 1].parse::<f64>() {
                Ok(n) if n.is_finite() && n > 0.0 => (n, 'x'),
                _ => continue,
            },
            _ => continue,
        };
        out.push((url, score, unit));
    }
    out
}
fn best_srcset(value: &str, base: &str) -> Option<String> {
    let mut candidates = srcset(value, base);
    if candidates.is_empty() {
        return None;
    }
    if candidates.iter().any(|c| c.2 == 'w') {
        candidates.retain(|c| c.2 == 'w');
    }
    candidates.sort_by(|a, b| a.1.total_cmp(&b.1));
    let limit = if candidates[0].2 == 'w' { 2560.0 } else { 3.0 };
    candidates
        .iter()
        .rev()
        .find(|c| c.1 <= limit)
        .or(candidates.first())
        .map(|c| c.0.clone())
}
fn placeholder(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    [
        "loading.",
        "loading-",
        "spacer.",
        "transparent.",
        "blank.gif",
        "placeholder.",
    ]
    .iter()
    .any(|x| u.contains(x))
}
fn normalized_image_url(im: &Selection<'_>, base: &str) -> Option<String> {
    let original = im.attr("src").map(|x| x.to_string());
    let mut choice = None;
    for name in ["data-srcset", "srcset"] {
        if let Some(v) = im.attr(name)
            && let Some(u) = best_srcset(&v, base)
        {
            choice = Some((u, name));
            break;
        }
    }
    if choice.is_none() {
        for name in ["data-src", "data-original", "data-lazy-src"] {
            if let Some(v) = im.attr(name)
                && let Some(u) = http(&v, base)
                && !placeholder(&u)
            {
                choice = Some((u, name));
                break;
            }
        }
    }
    if choice.is_none()
        && let Some(v) = &original
        && let Some(u) = http(v, base)
        && !placeholder(&u)
    {
        choice = Some((u, "src"));
    }
    choice.map(|(url, _reason)| url)
}

pub(crate) fn normalize(html: &str, base: &str) -> String {
    let doc = Document::from(html);
    normalize_document(&doc, base);
    doc.html().to_string()
}

pub(crate) fn normalize_document(doc: &Document, base: &str) -> HashMap<NodeId, NodeId> {
    let mut picture_urls = HashMap::new();
    let mut used_sources = HashMap::new();
    for node in doc.select("img").nodes() {
        let im = Selection::from(*node);
        let url = normalized_image_url(&im, base).or_else(|| {
            let parent = im.parent();
            if !parent.is("picture") {
                return None;
            }
            // 同じ picture に img が複数あっても、直下の source は一度だけ調べる。
            let (url, source) = picture_urls
                .entry(parent.nodes()[0].id)
                .or_insert_with(|| {
                    parent.children().nodes().iter().find_map(|node| {
                        if node.node_name().as_deref() != Some("source")
                            || node.attr("media").is_some()
                        {
                            return None;
                        }
                        Some((best_srcset(&node.attr("srcset")?, base)?, node.id))
                    })
                })
                .as_ref()?;
            used_sources.insert(node.id, *source);
            Some(url.clone())
        });
        if let Some(url) = url {
            im.set_attr("src", &url);
            im.remove_attrs(&[
                "srcset",
                "data-srcset",
                "data-src",
                "data-original",
                "data-lazy-src",
            ]);
        }
    }
    // 選んだ画像は img.src に入れた。文章と画像の位置は変えない。
    for n in doc.select("picture source").nodes() {
        Selection::from(*n).remove();
    }
    used_sources
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn srcset_commas_limits_and_invalid_descriptors() {
        assert_eq!(
            best_srcset(
                "https://img.example/a,b.jpg 400w, /b.jpg 1200w, /bad.jpg -2x, javascript:bad 3x",
                "https://site.example/"
            ),
            Some("https://site.example/b.jpg".into())
        );
        assert_eq!(
            best_srcset(
                "/a.jpg 400w, /b.jpg 2400w, /c.jpg 4000w",
                "https://site.example/"
            ),
            Some("https://site.example/b.jpg".into())
        );
        assert!(
            best_srcset(
                "/a.jpg 1w 2x, /b.jpg NaNx, /c.jpg 0x",
                "https://site.example/"
            )
            .is_none()
        );
    }
    #[test]
    fn keeps_lazy_images_in_their_original_links() {
        let html = normalize(
            "<p>before</p><a href='/photo/view'><img src='data:image/gif;base64,AA' data-src='/real.jpg'></a><p>after</p>",
            "https://site.example/post",
        );
        let doc = Document::from(html);
        assert_eq!(
            doc.select("a img").attr("src").as_deref(),
            Some("https://site.example/real.jpg")
        );
        assert_eq!(doc.select("a").attr("href").as_deref(), Some("/photo/view"));
        assert!(doc.text().contains("beforeafter"));
    }
    #[test]
    fn picture_fallback_does_not_override_a_valid_img_with_art_direction() {
        let doc = Document::from(normalize(
            "<picture><source media='(max-width:600px)' srcset='/cropped.webp 2x'><img src='/full.jpg'></picture><picture><source srcset='/fallback.webp 2x'><img src='data:image/gif;base64,AA'></picture><img data-src='javascript:evil' src='/safe.png'>",
            "https://site.example/",
        ));
        let sources: Vec<_> = doc
            .select("img")
            .nodes()
            .iter()
            .map(|n| Selection::from(*n).attr("src").unwrap().to_string())
            .collect();
        assert_eq!(
            sources,
            [
                "https://site.example/full.jpg",
                "https://site.example/fallback.webp",
                "https://site.example/safe.png"
            ]
        );
        assert!(
            http(
                "http://user:password@site.example/a",
                "https://site.example/"
            )
            .is_none()
        );
    }
    #[test]
    fn empty_lazy_attributes_do_not_replace_a_real_source_with_the_article_url() {
        let doc = Document::from(normalize(
            "<img data-src='' src='/real.jpg'><img data-src='#' src='/second.jpg'>",
            "https://site.example/post",
        ));
        let srcs: Vec<_> = doc
            .select("img")
            .nodes()
            .iter()
            .map(|n| Selection::from(*n).attr("src").unwrap().to_string())
            .collect();
        assert_eq!(
            srcs,
            [
                "https://site.example/real.jpg",
                "https://site.example/second.jpg"
            ]
        );
    }
}
