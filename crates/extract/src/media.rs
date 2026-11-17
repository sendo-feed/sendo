//! 画像ページの候補選びと、サムネイルと拡大画像の照合。外への取得はしない。
use dom_query::{Document, Selection};
use image::{DynamicImage, ImageReader, imageops::FilterType};
use std::io::Cursor;

/// 画像だけを含むリンク（元 DOM の順番）。呼ぶ側で取得数を制限する。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageLink {
    pub thumbnail: String,
    pub target: String,
}

pub fn image_links(html: &str, base: &str) -> Vec<ImageLink> {
    let doc = Document::from(html);
    let mut out = Vec::new();
    for node in doc.select("a[href]").nodes() {
        let link = Selection::from(*node);
        let images = link.select("img[src]");
        if images.length() != 1 || !link.text().trim().is_empty() {
            continue;
        }
        let image = images.first();
        let small = [("width", 80), ("height", 60)].iter().any(|(attr, min)| {
            image
                .attr(attr)
                .and_then(|v| v.parse::<u32>().ok())
                .is_some_and(|v| v < *min)
        });
        if small {
            continue;
        }
        let Some(thumbnail) = image
            .attr("src")
            .and_then(|v| crate::normalize::http(&v, base))
        else {
            continue;
        };
        let Some(target) = link
            .attr("href")
            .and_then(|v| crate::normalize::http(&v, base))
        else {
            continue;
        };
        if thumbnail != target
            && !out
                .iter()
                .any(|l: &ImageLink| l.thumbnail == thumbnail && l.target == target)
        {
            out.push(ImageLink { thumbnail, target });
        }
        if out.len() == 12 {
            break;
        }
    }
    out
}

/// HTML のリンク先から最大 3 候補。og:image は本文の写真とは限らないので使わない。
pub fn image_candidates(bytes: &[u8], content_type: Option<&str>, base: &str) -> Vec<String> {
    let html = crate::normalize::normalize(&crate::decode(bytes, content_type), base);
    let doc = Document::from(html);
    doc.select("nav, aside, header, footer, script, style, [hidden], [aria-hidden=true]")
        .remove();
    let mut candidates = Vec::new();
    for node in doc.select("img[src]").nodes() {
        let image = Selection::from(*node);
        let w = image
            .attr("width")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        let h = image
            .attr("height")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);
        if (w > 0 && w < 80) || (h > 0 && h < 60) {
            continue;
        }
        let Some(url) = image
            .attr("src")
            .and_then(|v| crate::normalize::http(&v, base))
        else {
            continue;
        };
        if !candidates.iter().any(|(u, _)| *u == url) {
            candidates.push((url, u64::from(w) * u64::from(h)));
        }
    }
    candidates.sort_by_key(|(_, area)| std::cmp::Reverse(*area));
    candidates.into_iter().take(3).map(|(url, _)| url).collect()
}

fn decode(bytes: &[u8]) -> Option<DynamicImage> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(10000);
    limits.max_image_height = Some(10000);
    limits.max_alloc = Some(200 * 1024 * 1024);
    let mut probe = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    probe.limits(limits.clone());
    let (width, height) = probe.into_dimensions().ok()?;
    if u64::from(width) * u64::from(height) > 40_000_000 {
        return None;
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    reader.limits(limits);
    reader.decode().ok()
}

/// 小さなアイコンを拡大しないため、取得した画像の実寸でも確かめる。
pub fn eligible_thumbnail(bytes: &[u8]) -> bool {
    decode(bytes).is_some_and(|im| im.width() >= 80 && im.height() >= 60)
}

/// 同じ写真の、縦横とも小さくない拡大版だけを許す。形式不明・壊れた画像は false。
pub fn is_larger_image(thumbnail: &[u8], candidate: &[u8]) -> bool {
    let (Some(a), Some(b)) = (decode(thumbnail), decode(candidate)) else {
        return false;
    };
    if a.width() < 80
        || a.height() < 60
        || b.width() < a.width()
        || b.height() < a.height()
        || u64::from(b.width()) * u64::from(b.height()) * 10
            <= u64::from(a.width()) * u64::from(a.height()) * 11
        || ((f64::from(a.width()) / f64::from(a.height()))
            / (f64::from(b.width()) / f64::from(b.height()))
            - 1.0)
            .abs()
            > 0.05
    {
        return false;
    }
    let small = |im: &DynamicImage| im.resize_exact(32, 32, FilterType::Triangle).to_rgb8();
    let pa = small(&a);
    let pb = small(&b);
    // 一様な背景では別の画像でも一致しやすい。十分な濃淡がないものは拡大しない。
    let gray = a.resize_exact(32, 32, FilterType::Triangle).to_luma8();
    let mean = gray.as_raw().iter().map(|v| f64::from(*v)).sum::<f64>() / 1024.0;
    let variance = gray
        .as_raw()
        .iter()
        .map(|v| (f64::from(*v) - mean).powi(2))
        .sum::<f64>()
        / 1024.0;
    if variance < 100.0 {
        return false;
    }
    let mae = pa
        .as_raw()
        .iter()
        .zip(pb.as_raw())
        .map(|(a, b)| (f64::from(*a) - f64::from(*b)).abs())
        .sum::<f64>()
        / (32.0 * 32.0 * 3.0 * 255.0);
    let hash = |im: &DynamicImage| {
        let gray = im.resize_exact(9, 8, FilterType::Triangle).to_luma8();
        let mut hash = 0u64;
        for y in 0..8 {
            for x in 0..8 {
                hash =
                    (hash << 1) | u64::from(gray.get_pixel(x, y)[0] > gray.get_pixel(x + 1, y)[0]);
            }
        }
        hash
    };
    mae <= 0.08 && (hash(&a) ^ hash(&b)).count_ones() <= 8
}

/// 照合を通った画像だけを置き換える。リンク先・写真の位置・その他の属性は保つ。
pub fn replace_image(html: &str, thumbnail: &str, target: &str, replacement: &str) -> String {
    let doc = Document::from(html);
    for node in doc.select("a[href]").nodes() {
        let link = Selection::from(*node);
        if link.attr("href").as_deref() != Some(target) {
            continue;
        }
        for image in link.select("img[src]").nodes() {
            let image = Selection::from(*image);
            if image.attr("src").as_deref() == Some(thumbnail) {
                image.set_attr("src", replacement);
                // 元のサムネイルの寸法を拡大画像に当てない。
                image.remove_attrs(&["width", "height"]);
            }
        }
    }
    doc.select("body").html().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn picture(w: u32, h: u32, inverted: bool) -> Vec<u8> {
        let image = image::RgbImage::from_fn(w, h, |x, y| {
            let value = ((x * 200 / w + y * 40 / h) as u8).min(240);
            image::Rgb([if inverted { 255 - value } else { value }, value, value])
        });
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    #[test]
    fn matches_larger_same_picture_but_not_different_equal_size_or_avatar() {
        let a = picture(100, 80, false);
        let b = picture(200, 160, false);
        assert!(is_larger_image(&a, &b));
        assert!(!is_larger_image(&a, &a));
        assert!(!is_larger_image(&a, &picture(200, 160, true)));
        assert!(!is_larger_image(
            &picture(48, 48, false),
            &picture(240, 240, false)
        ));
        assert!(!is_larger_image(b"not an image", &b));
        assert!(!is_larger_image(&b, &a));
    }
    #[test]
    fn does_not_upgrade_nearly_uniform_unrelated_images() {
        let png = |size, value| {
            let image = image::RgbImage::from_pixel(size, size, image::Rgb([value, value, value]));
            let mut bytes = Cursor::new(Vec::new());
            DynamicImage::ImageRgb8(image)
                .write_to(&mut bytes, image::ImageFormat::Png)
                .unwrap();
            bytes.into_inner()
        };
        assert!(!is_larger_image(&png(100, 255), &png(200, 250)));
    }
    #[test]
    fn discovers_and_replaces_only_the_confirmed_image_leaving_link_and_order() {
        let html = "<p>before</p><a href='/view'><img src='/thumb.png' width='100' height='80'></a><p>after</p><a href='/avatar'><img src='/avatar.png' width='48' height='48'></a><a href='/other'><img src='/thumb.png'></a>";
        let links = image_links(html, "https://site.example/post");
        assert_eq!(links.len(), 2);
        let html = replace_image(html, "/thumb.png", "/view", "https://img.example/full.png");
        let doc = Document::from(html);
        assert_eq!(
            doc.select("a[href='/view'] img").attr("src").as_deref(),
            Some("https://img.example/full.png")
        );
        assert_eq!(
            doc.select("a[href='/other'] img").attr("src").as_deref(),
            Some("/thumb.png")
        );
        assert!(doc.select("a[href='/view'] img").attr("width").is_none());
    }
    #[test]
    fn does_not_use_og_image_or_navigation_as_an_original() {
        let html = b"<meta property='og:image' content='/unrelated.png'><nav><img src='/logo.png' width='900'></nav><img src='./original.png' width='700' height='500'><img src='/avatar.png' width='48' height='48'>";
        assert_eq!(
            image_candidates(html, None, "https://site.example/photos/view.html"),
            ["https://site.example/photos/original.png"]
        );
    }
}
