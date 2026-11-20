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
    similar(&a, &b)
}

/// 縮小した画素の差と差分ハッシュで、同じ写真かを見る。一様な背景では別の画像でも一致しやすい
/// ので、十分な濃淡がないものは一致としない。縦横比は呼ぶ側で確かめる。
fn similar(a: &DynamicImage, b: &DynamicImage) -> bool {
    let small = |im: &DynamicImage| im.resize_exact(32, 32, FilterType::Triangle).to_rgb8();
    let pa = small(a);
    let pb = small(b);
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
    mae <= 0.08 && (hash(a) ^ hash(b)).count_ones() <= 8
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

/// 導入の画像（本文の最初の段落より前。3 枚まで）と、そのあとの画像（12 枚まで）の URL
/// （docs/decisions/content.md の 21）。小さいと書かれた画像（アイコン）は挙げない。拡大版への
/// 差し替え（20）で導入の画像と同じ URL になった本文の画像も、あとの画像に挙げる（19 の同じ URL
/// の重なりは、差し替えより前に落としているので、差し替えでできた重なりには効かない）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LeadImages {
    pub lead: Vec<String>,
    pub later: Vec<String>,
}

/// 段落とみなす要素。20 文字以上の文章を持つものが、本文の最初の段落
const PARAGRAPHS: &[&str] = &["p", "pre", "blockquote", "li", "dd", "td"];

pub fn lead_images(html: &str, base: &str) -> LeadImages {
    let doc = Document::from(html);
    let mut out = LeadImages::default();
    let mut in_body = false;
    for node in doc.select("*").nodes() {
        let name = node.node_name().map(|n| n.to_string()).unwrap_or_default();
        let element = Selection::from(*node);
        if !in_body
            && PARAGRAPHS.contains(&name.as_str())
            && element
                .text()
                .chars()
                .filter(|c| !c.is_whitespace())
                .count()
                >= 20
        {
            in_body = true;
        }
        if name != "img" {
            continue;
        }
        let small = [("width", 80), ("height", 60)].iter().any(|(attr, min)| {
            element
                .attr(attr)
                .and_then(|v| v.parse::<u32>().ok())
                .is_some_and(|v| v < *min)
        });
        if small {
            continue;
        }
        let Some(url) = element
            .attr("src")
            .and_then(|v| crate::normalize::http(&v, base))
        else {
            continue;
        };
        if !in_body && out.lead.len() < 3 {
            if !out.lead.contains(&url) {
                out.lead.push(url);
            }
        } else if !out.lead.is_empty() && out.later.len() < 12 && !out.later.contains(&url) {
            out.later.push(url);
        }
        if out.later.len() == 12 {
            break;
        }
    }
    out
}

/// 縁の一様な帯（レターボックス）を除いた範囲。色は各辺の角の画素と比べる。
fn trim_bars(image: &DynamicImage) -> DynamicImage {
    let rgb = image.to_rgb8();
    let (width, height) = rgb.dimensions();
    let close = |a: &image::Rgb<u8>, b: &image::Rgb<u8>| {
        a.0.iter().zip(b.0).all(|(x, y)| x.abs_diff(y) <= 16)
    };
    let row_is_bar =
        |y: u32, corner: &image::Rgb<u8>| (0..width).all(|x| close(rgb.get_pixel(x, y), corner));
    let column_is_bar = |x: u32, top: u32, bottom: u32, corner: &image::Rgb<u8>| {
        (top..bottom).all(|y| close(rgb.get_pixel(x, y), corner))
    };
    let top_corner = *rgb.get_pixel(0, 0);
    let bottom_corner = *rgb.get_pixel(0, height - 1);
    let mut top = 0;
    while top < height && row_is_bar(top, &top_corner) {
        top += 1;
    }
    let mut bottom = height;
    while bottom > top && row_is_bar(bottom - 1, &bottom_corner) {
        bottom -= 1;
    }
    if bottom == top {
        return image.clone();
    }
    let left_corner = *rgb.get_pixel(0, top);
    let right_corner = *rgb.get_pixel(width - 1, top);
    let mut left = 0;
    while left < width && column_is_bar(left, top, bottom, &left_corner) {
        left += 1;
    }
    let mut right = width;
    while right > left && column_is_bar(right - 1, top, bottom, &right_corner) {
        right -= 1;
    }
    if right == left {
        return image.clone();
    }
    image.crop_imm(left, top, right - left, bottom - top)
}

/// 縁の帯を除いてから、同じ写真かを見る。大きさは問わない（docs/decisions/content.md の 21）。
/// 縦横比・縮小した画素の差・差分ハッシュの基準は is_larger_image と同じ。帯を除くと縦か横が
/// 元の半分未満になる画像、濃淡の少ない画像、形式不明・壊れた画像は false。
pub fn is_same_picture(a: &[u8], b: &[u8]) -> bool {
    let (Some(a), Some(b)) = (decode(a), decode(b)) else {
        return false;
    };
    let trimmed = |image: &DynamicImage| {
        let inner = trim_bars(image);
        (inner.width() * 2 >= image.width()
            && inner.height() * 2 >= image.height()
            && inner.width() >= 80
            && inner.height() >= 60)
            .then_some(inner)
    };
    let (Some(a), Some(b)) = (trimmed(&a), trimmed(&b)) else {
        return false;
    };
    if ((f64::from(a.width()) / f64::from(a.height()))
        / (f64::from(b.width()) / f64::from(b.height()))
        - 1.0)
        .abs()
        > 0.05
    {
        return false;
    }
    similar(&a, &b)
}

/// 導入の画像を 1 枚落とす。URL（lead_images が返したもの）が同じ最初の画像だけを落とし、
/// 画像だけを入れていたリンクが空になったら、リンクも落とす。
pub fn remove_image(html: &str, src: &str, base: &str) -> String {
    let doc = Document::from(html);
    for node in doc.select("img[src]").nodes() {
        let image = Selection::from(*node);
        let url = image
            .attr("src")
            .and_then(|v| crate::normalize::http(&v, base));
        if url.as_deref() != Some(src) {
            continue;
        }
        // span などを挟んでも、画像を包むリンクを調べる。
        let mut link = node.parent();
        while let Some(parent) = link
            && parent.node_name().as_deref() != Some("a")
        {
            link = parent.parent();
        }
        image.remove();
        if let Some(link) = link.map(Selection::from)
            && link.select("img").length() == 0
            && link.text().trim().is_empty()
        {
            link.remove();
        }
        break;
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
    fn letterboxed(picture: &[u8], top: u32, left: u32) -> Vec<u8> {
        let inner = image::load_from_memory(picture).unwrap().to_rgb8();
        let (w, h) = inner.dimensions();
        let mut out =
            image::RgbImage::from_pixel(w + left * 2, h + top * 2, image::Rgb([3, 14, 10]));
        image::imageops::overlay(&mut out, &inner, i64::from(left), i64::from(top));
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(out)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    #[test]
    fn finds_the_same_picture_behind_letterbox_bars_at_any_size() {
        let wide = picture(320, 180, false);
        let smaller = picture(160, 90, false);
        assert!(is_same_picture(&letterboxed(&wide, 60, 0), &smaller));
        assert!(is_same_picture(&smaller, &letterboxed(&wide, 60, 0)));
        assert!(is_same_picture(&letterboxed(&wide, 0, 40), &wide));
        assert!(is_same_picture(&wide, &wide));
    }
    #[test]
    fn does_not_match_different_flat_cropped_or_broken_pictures() {
        let wide = picture(320, 180, false);
        assert!(!is_same_picture(&wide, &picture(320, 180, true)));
        assert!(!is_same_picture(
            &letterboxed(&wide, 60, 0),
            &picture(160, 90, true)
        ));
        let flat = |value| {
            let image = image::RgbImage::from_pixel(200, 150, image::Rgb([value, value, value]));
            let mut bytes = Cursor::new(Vec::new());
            DynamicImage::ImageRgb8(image)
                .write_to(&mut bytes, image::ImageFormat::Png)
                .unwrap();
            bytes.into_inner()
        };
        assert!(!is_same_picture(&flat(200), &flat(205)));
        // 帯を除くと縦が元の半分未満になる
        assert!(!is_same_picture(&letterboxed(&wide, 200, 0), &wide));
        assert!(!is_same_picture(b"not an image", &wide));
        assert!(!is_same_picture(&wide, b"not an image"));
    }
    #[test]
    fn lists_lead_images_before_the_first_paragraph() {
        let html = "<div><img src='/cover.jpg'></div><h1>見出し</h1><div><img src='/cover.jpg'><img src='/cover-sp.jpg'><img src='/icon.svg' width='20'></div><p>短い</p><p>本文の最初の段落です。ここから記事の内容が始まります。</p><a href='/view'><img src='/body.jpg'></a><p>本文の段落です。<img src='/inline.png'></p><a href='/full'><img src='https://news.example/cover.jpg'></a>";
        let images = lead_images(html, "https://news.example/post");
        assert_eq!(
            images.lead,
            [
                "https://news.example/cover.jpg",
                "https://news.example/cover-sp.jpg"
            ]
        );
        assert_eq!(
            images.later,
            [
                "https://news.example/body.jpg",
                "https://news.example/inline.png",
                // 拡大版への差し替えで導入と同じ URL になった本文の画像も、照合の相手にする
                "https://news.example/cover.jpg"
            ]
        );
        let none = lead_images(
            "<p>本文の最初の段落です。ここから記事の内容が始まります。</p><img src='/a.jpg'>",
            "https://news.example/post",
        );
        assert_eq!(none, LeadImages::default());
    }
    #[test]
    fn removes_only_the_first_matching_image_and_its_empty_link() {
        let html = "<a href='/view'><span><img src='/cover.jpg'></span></a><p>本文</p><a href='/full'><img src='https://news.example/cover.jpg'></a>";
        let result = remove_image(
            html,
            "https://news.example/cover.jpg",
            "https://news.example/post",
        );
        let doc = Document::from(result);
        assert_eq!(doc.select("img").length(), 1);
        assert_eq!(doc.select("a[href='/view']").length(), 0);
        assert_eq!(doc.select("a[href='/full'] img").length(), 1);
        let kept = remove_image(
            "<a href='/view'>表紙<img src='/cover.jpg'></a>",
            "https://news.example/cover.jpg",
            "https://news.example/post",
        );
        assert!(kept.contains("表紙"));
        assert!(!kept.contains("<img"));
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
