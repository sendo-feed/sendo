//! 全 body を残した DOM から、本文の手掛かりを集め、その共通の領域を残す。
//!
//! 抽出器が作り直した HTML を配らない。元の DOM を使うので、段落間の画像・リンク・導入文を
//! 保てる。ホスト名やサイト別のセレクタは使わない。
use std::collections::HashSet;

use dom_query::{Document, NodeId, NodeRef, Selection};
use url::Url;

use crate::{ExtractError, Extracted};

const BODY_BLOCKS: &str =
    "p, pre, td, th, blockquote, div, section, article, main, body, li, dt, dd";

const POST_LINKS: &str = "blockquote.twitter-tweet a[href], blockquote.imgur-embed-pub a[href]";
const IMGUR_LINK: &str = "blockquote.imgur-embed-pub a[href]";
const ARTICLE: &str =
    "article, [itemscope][itemtype$='Article'], [itemscope][itemtype$='BlogPosting']";
const ARTICLE_BODY: &str = "[itemprop=articleBody]";

fn compact(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

fn imgur_resource(value: &str, base: &str) -> Option<Url> {
    let mut url = Url::parse(&crate::normalize::http(value, base)?).ok()?;
    if url.host_str() != Some("i.imgur.com") {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

fn has_post_embed(block: &Selection<'_>, base: &str) -> bool {
    block.is(POST_LINKS)
        || block.select(POST_LINKS).exists()
        || block
            .nodes()
            .iter()
            .filter(|node| node.node_name().as_deref() == Some("img"))
            .chain(block.select("img[src]").nodes())
            .any(|image| {
                image
                    .attr("src")
                    .and_then(|src| imgur_resource(&src, base))
                    .is_some()
            })
}

fn collect_imgur_images(doc: &Document, base: &str) -> Vec<(NodeId, Url)> {
    if !doc.select(IMGUR_LINK).exists() {
        return Vec::new();
    }
    let mut images = Vec::new();
    let mut collect = |node: NodeRef<'_>| {
        let sets: &[_] = if node.node_name().as_deref() == Some("img") {
            // 正規化で選ばれない URL も、直リンクから再生成しないように記録する。
            for name in ["src", "data-src", "data-original", "data-lazy-src"] {
                if let Some(url) = node
                    .attr(name)
                    .and_then(|value| imgur_resource(&value, base))
                {
                    images.push((node.id, url));
                }
            }
            &["srcset", "data-srcset"]
        } else if Selection::from(node).parent().is("picture") {
            &["srcset"]
        } else {
            return;
        };
        for name in sets {
            if let Some(value) = node.attr(name) {
                images.extend(
                    crate::normalize::srcset(&value, base)
                        .into_iter()
                        .filter_map(|(url, _, _)| imgur_resource(&url, base))
                        .map(|url| (node.id, url)),
                );
            }
        }
    };
    for node in doc.select("img, picture > source[srcset]").nodes() {
        collect(*node);
    }

    let mut templates = doc.select("template").nodes().to_vec();
    // template の中身は文書とは別の木にあるので、ふつうのセレクタからは見えない。
    while let Some(template) = templates.pop() {
        let fragment = template
            .element_ref()
            .and_then(|element| element.template_contents);
        if let Some(fragment) = fragment.and_then(|id| doc.tree.get(&id)) {
            for node in fragment.descendants_it() {
                match node.node_name().as_deref() {
                    Some("img" | "source") => collect(node),
                    Some("template") => templates.push(node),
                    _ => {}
                }
            }
        }
    }
    images
}

fn prune(doc: &Document, base: &str) {
    doc.select("nav, aside, script, style, noscript, template, form, [hidden], [aria-hidden=true], [role=navigation], [role=banner], [role=contentinfo], [role=complementary]").remove();
    // 完全な語か区切りで比較し、本文の単語の部分一致では消さない。
    const NOISE: &[&str] = &[
        "related-posts",
        "related-articles",
        "related-entries",
        "recommended",
        "recommendations",
        "ranking",
        "sidebar",
        "social-share",
        "share-buttons",
        "advertisement",
        "ad-container",
        "ads",
        "newsletter",
        "author-profile",
        "site-footer",
        "comments",
        "comment-form",
    ];
    for node in doc.select("div, section, ul, ol, footer, header").nodes() {
        let block = Selection::from(*node);
        let names = format!(
            "{} {}",
            block.attr("class").unwrap_or_default(),
            block.attr("id").unwrap_or_default()
        )
        .to_ascii_lowercase()
        .replace('_', "-");
        if names.split_whitespace().any(|part| {
            NOISE
                .iter()
                .any(|word| part == *word || part.starts_with(&format!("{word}-")))
        }) {
            block.remove();
        }
    }
    // 文章を持たず、短いリンクだけで構成されたカードの集まりを除く。写真だけのリンクは残す。
    // figure の中や段落そのものには当てない。通常の本文中のリンクやキャプションを守る。
    for node in doc.select("div, section, ul").nodes().iter().rev() {
        let block = Selection::from(*node);
        let text = compact(&block.text()).chars().count();
        let links = block.select("a[href]");
        let link_text: usize = links
            .nodes()
            .iter()
            .map(|n| compact(&Selection::from(*n).text()).chars().count())
            .sum();
        let related = if block.is("ul")
            && links.length() >= 3
            && block.children().nodes().iter().all(|node| {
                let item = Selection::from(*node);
                item.is("br")
                    || (item.is("li")
                        && item.children().length() == 1
                        && item.children().is("a[href]")
                        && compact(&item.text()) == compact(&item.select("a[href]").text()))
            })
            && !block.select("img, video, audio, iframe").exists()
        {
            related_heading_before(&block)
        } else {
            None
        };
        if ((20..240).contains(&text) || related.is_some())
            && link_text * 10 >= text * 9
            && (links.length() >= 3 || block.select("img").length() > 0)
            && block.select("figure, p, pre, table").length() == 0
            && !has_post_embed(&block, base)
        {
            if let Some(heading) = related {
                heading.remove();
            }
            block.remove();
        }
    }
}

// 本文に選ばれなかった領域の画像も、直リンクから生成し直さない。
fn mark_removed_imgur_images(blocks: &[&Selection<'_>], images: Vec<(NodeId, Url)>, base: &str) {
    if images.is_empty() {
        return;
    }
    let mut visible = HashSet::new();
    let source = |node: &NodeRef<'_>| Some((node.id, imgur_resource(&node.attr("src")?, base)?));
    for block in blocks {
        if block.is("img") {
            visible.extend(block.nodes().iter().filter_map(source));
        }
        visible.extend(block.select("img[src]").nodes().iter().filter_map(source));
    }
    let removed: HashSet<_> = images
        .into_iter()
        .filter(|image| !visible.contains(image))
        .map(|(_, url)| url)
        .collect();
    if removed.is_empty() {
        return;
    }
    for block in blocks {
        for node in block.select(IMGUR_LINK).nodes() {
            if let Some(href) = node
                .attr("href")
                .and_then(|href| imgur_resource(&href, base))
                && removed.contains(&href)
            {
                Selection::from(*node).set_attr("data-sendo-imgur-image-removed", "true");
            }
        }
    }
}

fn related_heading_before<'a>(block: &Selection<'a>) -> Option<Selection<'a>> {
    let mut previous = block.prev_sibling();
    for _ in 0..6 {
        if !previous.is("br, hr") {
            let label = previous
                .text()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            return (matches!(
                label.to_ascii_lowercase().as_str(),
                "関連記事" | "related articles" | "related posts"
            ) && !previous.select("a, p, div, section, article, ul, ol, table, blockquote, img, video, audio, iframe").exists())
            .then_some(previous);
        }
        previous = previous.prev_sibling();
    }
    None
}

pub(crate) fn extract(html: &str, url: &str) -> Result<Extracted, ExtractError> {
    let doc = Document::from(html);
    let elements = doc.select("*");
    if elements.length() > 50_000 {
        return Err(ExtractError::NoContent);
    }
    let mut depths = std::collections::HashMap::new();
    for node in elements.nodes() {
        let depth = node
            .parent()
            .and_then(|p| depths.get(&p.id).copied())
            .unwrap_or(0usize)
            + 1;
        if depth > 128 {
            return Err(ExtractError::NoContent);
        }
        depths.insert(node.id, depth);
    }
    let imgur_images = collect_imgur_images(&doc, url);
    crate::normalize::normalize_document(&doc, url);
    prune(&doc, url);
    let page_title = doc.select("title").text().to_string();
    // 記事を明示した領域は、短い記事をサイドバーの長文に負けさせない手掛かりにする。
    // 見出しや表紙しかない article には絞らず、body に残した文章も調べる。
    let mut semantic = None;
    let mut semantic_size = 0;
    for node in doc.select("article, [itemprop=articleBody]").nodes() {
        let block = Selection::from(*node);
        let prose: usize = block
            .select("p, pre, li, td, th, dt, dd")
            .nodes()
            .iter()
            .map(|p| {
                let p = Selection::from(*p);
                if p.select("p, pre, li, td, th, dt, dd").length() > 0 {
                    return 0;
                }
                let text = compact(&p.text()).chars().count();
                let linked = compact(&p.select("a").text()).chars().count();
                if text >= 10 && linked * 2 < text {
                    text
                } else {
                    0
                }
            })
            .sum();
        let heading = compact(&block.select("h1, h2").first().text());
        let named = block.attr("itemprop").as_deref() == Some("articleBody")
            || (heading.chars().count() >= 5 && compact(&page_title).contains(&heading));
        let outside_body = block.parent().children().nodes().iter().any(|sibling| {
            if sibling.id == node.id {
                return false;
            }
            let sibling = Selection::from(*sibling);
            let paragraphs: Vec<_> = sibling
                .select("p, pre")
                .nodes()
                .iter()
                .filter_map(|p| {
                    let p = Selection::from(*p);
                    let length = compact(&p.text()).chars().count();
                    let linked = compact(&p.select("a").text()).chars().count();
                    (length >= 40 && linked * 2 < length).then_some(length)
                })
                .collect();
            let outside_prose: usize = paragraphs.iter().sum();
            paragraphs.len() >= 3 && outside_prose > 300 && outside_prose > prose * 3
        });
        if named && prose >= 40 && prose > semantic_size && !outside_body {
            semantic_size = prose;
            semantic = Some(*node);
        }
    }
    // 意味的な領域は文章の手掛かりに使う。出力用の DOM から隣の導入や画像を消さない。
    let input = if let Some(node) = semantic {
        let seed_doc = Document::from(doc.html().to_string());
        seed_doc
            .select("body")
            .set_html(Selection::from(node).html().to_string());
        seed_doc.html().to_string()
    } else {
        doc.html().to_string()
    };
    let options = rs_trafilatura::Options {
        url: Some(url.to_owned()),
        include_images: true,
        include_links: true,
        include_formatting: true,
        ..Default::default()
    };
    // rs-trafilatura の HTML シリアライザーは画像の位置を失うため、文章の手掛かりだけに使う。
    let result = rs_trafilatura::extract_with_options(&input, &options).ok();
    let fallback = if result
        .as_ref()
        .is_none_or(|r| r.content_text.trim().is_empty())
    {
        dom_smoothie::Readability::new(input, Some(url), None)
            .ok()
            .and_then(|mut r| r.parse().ok())
    } else {
        None
    };
    let seed = compact(
        &result
            .as_ref()
            .filter(|r| !r.content_text.trim().is_empty())
            .map(|r| r.content_text.clone())
            .or_else(|| fallback.as_ref().map(|r| r.text_content.to_string()))
            .ok_or(ExtractError::NoContent)?,
    );
    let title = result
        .and_then(|r| r.metadata.title)
        .or_else(|| fallback.map(|r| r.title.to_string()))
        .unwrap_or_else(|| page_title.clone());

    let mut anchors = Vec::new();
    for node in doc.select(BODY_BLOCKS).nodes() {
        if let Some(scope) = semantic
            && node.id != scope.id
            && !Selection::from(*node)
                .ancestors(Some(128))
                .nodes()
                .iter()
                .any(|parent| parent.id == scope.id)
        {
            continue;
        }
        let block = Selection::from(*node);
        // 同じ文章を親と子で重ねて数えない。
        if block.select(BODY_BLOCKS).length() > 0 {
            continue;
        }
        let text = compact(&block.text());
        let len = text.chars().count();
        if len < 20 {
            continue;
        }
        let linked: usize = block
            .select("a")
            .nodes()
            .iter()
            .map(|n| compact(&Selection::from(*n).text()).chars().count())
            .sum();
        if linked * 2 > len {
            continue;
        }
        let sample: String = text.chars().take(80).collect();
        if seed.contains(&sample) {
            anchors.push((*node, len.min(200)));
        }
        if anchors.len() == 512 {
            break;
        }
    }
    let total: usize = anchors.iter().map(|(_, weight)| weight).sum();
    if total == 0 && semantic.is_none() {
        return Err(ExtractError::NoContent);
    }

    let mut candidates = std::collections::HashMap::new();
    for (anchor, weight) in &anchors {
        candidates.entry(anchor.id).or_insert((*anchor, 0usize)).1 += weight;
        for node in Selection::from(*anchor).ancestors(Some(128)).nodes() {
            let candidate = candidates.entry(node.id).or_insert((*node, 0usize));
            candidate.1 += weight;
        }
    }
    let mut best = semantic.map(Selection::from);
    let mut best_size = best
        .as_ref()
        .map(|s| compact(&s.text()).chars().count())
        .unwrap_or(usize::MAX);
    // 文書の順に評価し、同じ大きさなら外側を残す。画像しかない隣接ブロックも保持する。
    for node in doc
        .select("body, main, article, section, div, [role=main]")
        .nodes()
    {
        let Some((_, weight)) = candidates.get(&node.id) else {
            continue;
        };
        if *weight < total {
            continue;
        }
        if let Some(scope) = semantic
            && node.id != scope.id
            && !Selection::from(scope)
                .ancestors(Some(128))
                .nodes()
                .iter()
                .any(|parent| parent.id == node.id)
        {
            continue;
        }
        let block = Selection::from(*node);
        let size = compact(&block.text()).chars().count();
        if size < best_size {
            best = Some(block);
            best_size = size;
        }
    }
    let mut root = best.ok_or(ExtractError::NoContent)?;
    // 同じ記事の見出しと導入画像が隣のブロックに分かれている場合は、一緒に残す。
    let title_key = compact(&page_title);
    let has_heading = root.select("h1").length() > 0;
    for node in root.ancestors(Some(3)).nodes() {
        let parent = Selection::from(*node);
        let size = compact(&parent.text()).chars().count();
        let heading = compact(&parent.select("h1").first().text());
        let content_parent = matches!(node.node_name().as_deref(), Some("article" | "main"))
            || parent.attr("role").as_deref() == Some("main");
        let lead_image = content_parent
            && parent.children().nodes().iter().any(|sibling| {
                let sibling = Selection::from(*sibling);
                matches!(
                    sibling.nodes()[0].node_name().as_deref(),
                    Some("header" | "figure" | "picture")
                ) && sibling.select("img").length() > 0
                    && compact(&sibling.text()).chars().count() <= 200
            });
        if size <= best_size * 3 / 2
            && ((!has_heading && heading.chars().count() >= 5 && title_key.contains(&heading))
                || lead_image)
        {
            root = parent;
            break;
        }
    }
    let leading = leading_embeds(&root, url);
    let blocks: Vec<_> = leading.iter().chain(std::iter::once(&root)).collect();
    mark_removed_imgur_images(&blocks, imgur_images, url);
    let mut html = String::new();
    let mut text_length = 0;
    for block in blocks {
        // 相対 URL はリダイレクト後の記事 URL を基準にする。HTML の base タグは信用しない。
        for node in block.select("a[href], img[src]").nodes() {
            let el = Selection::from(*node);
            let attr = if el.attr("src").is_some() {
                "src"
            } else {
                "href"
            };
            if let Some(value) = el.attr(attr)
                && let Some(value) = crate::normalize::http(&value, url)
            {
                el.set_attr(attr, &value);
            }
        }
        html.push_str(&block.html());
        text_length += block.text().trim().chars().count();
    }
    if text_length == 0 {
        return Err(ExtractError::NoContent);
    }
    Ok(Extracted {
        title: title.trim().to_owned(),
        html,
        text_length,
    })
}

/// 選ばれた本文と同じ記事の範囲で、手前に分かれた埋め込みを含むブロックを探す。
fn leading_embeds<'a>(root: &Selection<'a>, base: &str) -> Vec<Selection<'a>> {
    const REGION: &str = "section, [role=region]";
    if root.is(ARTICLE) || root.is("body") {
        return Vec::new();
    }
    let ancestors = root.ancestors(Some(128));
    let article_boundary = ancestors
        .nodes()
        .iter()
        .find(|node| Selection::from(**node).is(ARTICLE))
        .or_else(|| {
            ancestors
                .nodes()
                .iter()
                .find(|node| Selection::from(**node).is(ARTICLE_BODY))
        });
    let boundary = article_boundary.or_else(|| {
        if root.is(ARTICLE_BODY) {
            return ancestors.nodes().iter().find(|node| {
                Selection::from(**node).is("section, [role=region], main, [role=main]")
            });
        }
        if root.is(REGION) {
            return ancestors.nodes().first().filter(|node| {
                Selection::from(**node).is("section, [role=region], main, [role=main]")
            });
        }
        if root.is("main, [role=main]") {
            return None;
        }
        ancestors.nodes().iter().find(|node| {
            Selection::from(**node).is("section, [role=region], main, [role=main], body")
        })
    });
    let Some(boundary) = boundary else {
        return Vec::new();
    };

    let mut leading = Vec::new();
    let outside_section = article_boundary.is_none() && root.is(REGION) && !root.is(ARTICLE_BODY);
    let branches = std::iter::once(root.clone())
        .chain(ancestors.nodes().iter().map(|node| Selection::from(*node)));
    for branch in branches.take_while(|branch| branch.nodes()[0].id != boundary.id) {
        let mut sibling = branch.prev_sibling();
        let mut blocks = 0;
        for _ in 0..32 {
            if !sibling.exists() || blocks == 6 {
                break;
            }
            let previous = sibling.prev_sibling();
            if !sibling.is("br, hr") {
                blocks += 1;
                if sibling.is(ARTICLE)
                    || sibling.is(ARTICLE_BODY)
                    || sibling.select(ARTICLE).exists()
                    || sibling.select(ARTICLE_BODY).exists()
                    || (article_boundary.is_none()
                        && (sibling.is(REGION) || sibling.select(REGION).exists()))
                {
                    break;
                }
                // 本文の印のない節では、直接並ぶ埋め込みだけを引き継ぐ。
                if outside_section
                    && (!branch.is(REGION)
                        || !sibling.is("blockquote.twitter-tweet, blockquote.imgur-embed-pub, img, figure, picture"))
                {
                    break;
                }
                if has_post_embed(&sibling, base) && !has_site_chrome(&sibling) {
                    leading.push(sibling);
                }
            }
            sibling = previous;
        }
    }
    leading.reverse();
    leading
}

// 記事や節を囲む header / footer は導入や出典になりうる。文書全体のものだけを除く。
fn has_site_chrome(block: &Selection<'_>) -> bool {
    const CHROME: &str = "header, footer, [role=banner], [role=contentinfo]";
    const SECTION: &str = "article, section, [itemprop=articleBody]";
    block
        .nodes()
        .iter()
        .filter(|node| Selection::from(**node).is(CHROME))
        .chain(block.select(CHROME).nodes())
        .any(|node| {
            let region = Selection::from(*node);
            let ancestors = region.ancestors(Some(128));
            region.is("[role=banner], [role=contentinfo]")
                || (!ancestors.is(SECTION) && !ancestors.is(ARTICLE))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn paragraphs() -> String {
        (0..6).map(|i|format!("<p>本文の段落{i}には調査の経緯と結果を書きます。読み手に必要な詳しい説明を順に並べ、途中に置かれた写真と最後の結論まで伝える記事です。</p>")).collect()
    }
    #[test]
    fn keeps_lead_gallery_links_and_captions_in_order() {
        let html = format!(
            "<title>検証用の記事の見出し | 雑誌</title><nav>ナビゲーション</nav><div><h1>検証用の記事の見出し</h1><div><p>最初の短い導入です。</p><a href='/photo/one.html'><img src='/one.jpg'></a></div><div>{}<figure><a href='/photo/two.html'><img src='/two.jpg'></a><figcaption>写真の説明</figcaption></figure><section class='related-posts'><p>関連記事の一覧です。</p></section><div><a href='/buy'><img src='/ad.jpg'>この広告の書籍を購入するための商品へのリンクです</a></div></div></div><aside><p>{}</p></aside>",
            paragraphs(),
            "著者の経歴と仕事の依頼。".repeat(100)
        );
        let result = extract(&html, "https://magazine.example/post").unwrap();
        assert!(result.html.contains("最初の短い導入"));
        assert!(result.html.contains("写真の説明"));
        assert!(!result.html.contains("関連記事の一覧"));
        assert!(!result.html.contains("ad.jpg"));
        assert!(!result.html.contains("著者の経歴"));
        let first = result
            .html
            .find("https://magazine.example/photo/one.html")
            .unwrap();
        let second = result
            .html
            .find("https://magazine.example/photo/two.html")
            .unwrap();
        assert!(first < second);
    }
    #[test]
    fn keeps_embedded_posts_in_the_preceding_body_block() {
        let html = format!(
            r#"<title>埋め込みが先にある記事</title><main>
            <section><article><blockquote class="twitter-tweet"><a href="https://x.com/example/status/999">別記事</a></blockquote></article></section>
            <article>
              <section><p>導入文</p><blockquote class="twitter-tweet"><a href="https://twitter.com/example/status/123"></a></blockquote>
              <div id="related-title">関連記事</div><ul class="manual-related"><li><a href="/one">対象外</a></li><li><a href="/two">対象外</a></li><li><a href="/three">対象外</a></li></ul>
              </section>
              <blockquote class="imgur-embed-pub"><a href="//i.imgur.com/example.jpeg">画像の説明</a></blockquote>
              <div class="social-share">共有</div>
              <section><div>{}<ul class="work-related"><li>手順を残す</li></ul></div></section>
            </article></main>"#,
            paragraphs()
        );
        let result = crate::extract(
            html.as_bytes(),
            Some("text/html;charset=utf-8"),
            "https://blog.example/post",
        )
        .unwrap();
        let doc = Document::from(result.html);
        assert!(doc.select("blockquote.twitter-tweet a[href]").exists());
        assert_eq!(
            doc.select("blockquote.imgur-embed-pub a")
                .attr("href")
                .as_deref(),
            Some("https://i.imgur.com/example.jpeg"),
        );
        assert!(!doc.text().contains("関連記事"));
        assert!(!doc.text().contains("対象外"));
        assert!(!doc.text().contains("共有"));
        assert!(!doc.text().contains("別記事"));
        assert!(doc.text().contains("画像の説明"));
        assert!(doc.text().contains("手順を残す"));
        let html = doc.html();
        assert!(html.find("/status/123").unwrap() < html.find("example.jpeg").unwrap());
        let text = doc.text();
        assert!(text.find("導入文").unwrap() < text.find("本文の段落0").unwrap());
    }
    #[test]
    fn keeps_short_reference_lists_with_related_headings() {
        let page = Document::from(
            r#"<article><h2 class="related-title">関連する一次資料</h2>
            <ul><li><a href="/one">資料一</a></li><li><a href="/two">資料二</a></li><li><a href="/three">資料三</a></li></ul>
            <h2 class="related-title">関連記事</h2>
            <ul class="manual-related"><li><a href="/a">別一</a></li><li><a href="/b">別二</a></li><li><a href="/c">別三</a></li></ul></article>"#,
        );
        prune(&page, "https://blog.example/post");
        assert!(page.text().contains("関連する一次資料"));
        assert!(page.text().contains("資料三"));
        assert!(!page.text().contains("関連記事"));
        assert!(!page.text().contains("別三"));
    }

    #[test]
    fn keeps_a_direct_imgur_image_in_the_lead_without_article_markup() {
        let doc = Document::from(
            r#"<main><section><img src="https://i.imgur.com/example.jpeg">
            <picture><img src="http://i.imgur.com/link.jpeg"></picture>
            <figure><img src="//I.IMGUR.COM/protocol-relative.jpeg"><figcaption>冒頭の画像</figcaption></figure>
            <img src="https://i.imgur.com.example/unrelated.jpeg">
            <blockquote class="imgur-embed-pub"><a href="https://imgur.com/a/link">投稿</a></blockquote>
            <div id="body">記事本文</div></section></main>"#,
        );
        let leads = leading_embeds(&doc.select("#body"), "https://blog.example/post");
        assert_eq!(leads.len(), 4);
        assert!(leads[0].is("img"));
        assert!(leads[1].select("img").exists());
        assert!(leads[2].text().contains("冒頭の画像"));
        assert!(leads[3].text().contains("投稿"));
    }

    #[test]
    fn does_not_bring_shared_page_regions_into_the_body() {
        for container in ["div", "main", "div role='main'"] {
            let tag = container.split_whitespace().next().unwrap();
            let doc = Document::from(format!(
                r#"<body><{container}><header><blockquote class="twitter-tweet"><a href="https://x.com/example/status/123">注目</a></blockquote></header><footer><blockquote class="twitter-tweet"><a href="https://x.com/example/status/456">おすすめ</a></blockquote></footer><div id="body">記事本文</div></{tag}></body>"#,
            ));
            assert!(leading_embeds(&doc.select("#body"), "https://blog.example/post").is_empty());
        }
    }

    #[test]
    fn keeps_an_intro_heading_separated_by_line_breaks() {
        let doc = Document::from(format!(
            r#"<article><section><header><h2>導入</h2></header><blockquote class="twitter-tweet"><a href="https://x.com/example/status/123">引用</a></blockquote></section>{}<section id="body">記事本文</section></article>"#,
            "<br>".repeat(8)
        ));
        let leads = leading_embeds(&doc.select("#body"), "https://blog.example/post");
        assert_eq!(leads.len(), 1);
        assert!(leads[0].select("h2").exists());
    }

    #[test]
    fn keeps_the_header_inside_the_article() {
        let doc = Document::from(
            r#"<main><article><header><blockquote class="twitter-tweet"><a href="https://x.com/example/status/123">引用</a></blockquote></header><div id="body">記事本文</div></article></main>"#,
        );
        let leads = leading_embeds(&doc.select("#body"), "https://blog.example/post");
        assert_eq!(leads.len(), 1);
        assert!(leads[0].is("header"));
        doc.select("#body").set_attr("role", "main");
        let leads = leading_embeds(&doc.select("#body"), "https://blog.example/post");
        assert_eq!(leads.len(), 1);
        assert!(leads[0].is("header"));
    }

    #[test]
    fn keeps_the_removal_of_hidden_imgur_images() {
        let doc = Document::from(
            r#"<article><blockquote class="imgur-embed-pub">
            <a href="https://i.imgur.com/photo.jpeg#post">投稿</a>
            <span hidden><img src="//i.imgur.com/photo.jpeg#pixel" width="1" height="1"></span>
            <template><template><img data-src="https://i.imgur.com/template.jpeg" width="1" height="1"></template>
            <img srcset="https://i.imgur.com/responsive.jpeg 2x"><img src="https://i.imgur.com/blank.gif" width="1" height="1"></template>
            <a href="https://i.imgur.com/template.jpeg">ひな形の投稿</a>
            <a href="https://i.imgur.com/responsive.jpeg">レスポンシブ画像</a>
            <a href="https://i.imgur.com/blank.gif">空欄の画像</a>
            <a href="https://i.imgur.com/other.jpeg">別の投稿</a>
            </blockquote></article>"#,
        );
        let base = "https://blog.example/post";
        let images = collect_imgur_images(&doc, base);
        prune(&doc, base);
        mark_removed_imgur_images(&[&doc.select("article")], images, base);
        assert!(!doc.select("img").exists());
        let links = doc.select("a[data-sendo-imgur-image-removed=true]");
        assert_eq!(
            links.attr("href").as_deref(),
            Some("https://i.imgur.com/photo.jpeg#post")
        );
        assert_eq!(links.length(), 4);
        assert!(
            doc.select("a[href$='template.jpeg'][data-sendo-imgur-image-removed]")
                .exists()
        );
    }

    #[test]
    fn does_not_restore_imgur_images_outside_the_extracted_blocks() {
        let doc = Document::from(
            r#"<article><div id="body"><blockquote class="imgur-embed-pub">
            <a href="https://i.imgur.com/photo.jpeg">投稿</a></blockquote></div>
            <div><img src="https://i.imgur.com/photo.jpeg" width="1" height="1"></div></article>"#,
        );
        let base = "https://blog.example/post";
        let images = collect_imgur_images(&doc, base);
        prune(&doc, base);
        assert!(doc.select("img").exists());
        mark_removed_imgur_images(&[&doc.select("#body")], images, base);
        assert!(
            doc.select("a[data-sendo-imgur-image-removed=true]")
                .exists()
        );
    }

    #[test]
    fn does_not_cross_separate_sections_under_an_unmarked_main() {
        let doc = Document::from(
            r#"<main><section><h2>別の特集</h2>
            <blockquote class="twitter-tweet"><a href="https://x.com/user/status/123">別の投稿</a></blockquote></section>
            <div id="body">本文</div></main>"#,
        );
        assert!(leading_embeds(&doc.select("#body"), "https://blog.example/post").is_empty());
    }

    #[test]
    fn keeps_direct_embeds_next_to_the_selected_section_without_crossing_another_section() {
        let doc = Document::from(
            r#"<main><blockquote class="twitter-tweet"><a href="https://x.com/user/status/789">手前の別の記事</a></blockquote>
            <section>別の記事</section>
            <blockquote class="twitter-tweet"><a href="https://x.com/user/status/123">本文の直前</a></blockquote>
            <section id="body">本文</section></main>"#,
        );
        let lead = leading_embeds(&doc.select("#body"), "https://blog.example/post");
        assert_eq!(lead.len(), 1);
        assert_eq!(lead[0].text().trim(), "本文の直前");
    }

    #[test]
    fn keeps_embeds_in_the_section_surrounding_the_explicit_article_body() {
        let doc = Document::from(
            r#"<main><blockquote class="twitter-tweet"><a href="https://x.com/user/status/789">別の記事</a></blockquote>
            <section><div><blockquote class="twitter-tweet"><a href="https://x.com/user/status/123">本文の直前</a></blockquote></div>
            <section itemprop="articleBody">本文</section></section></main>"#,
        );
        let lead = leading_embeds(
            &doc.select("[itemprop=articleBody]"),
            "https://blog.example/post",
        );
        assert_eq!(lead.len(), 1);
        assert_eq!(lead[0].text().trim(), "本文の直前");
    }

    #[test]
    fn does_not_take_a_promotion_before_the_section_that_contains_the_article() {
        let doc = Document::from(
            r#"<main><div><h2>編集部のおすすめ</h2>
            <blockquote class="twitter-tweet"><a href="https://x.com/user/status/456">別の引用</a></blockquote></div>
            <section><div id="body">本文</div></section></main>"#,
        );
        assert!(leading_embeds(&doc.select("#body"), "https://blog.example/post").is_empty());
    }

    #[test]
    fn keeps_a_quote_in_an_element_that_looks_like_a_related_heading() {
        let doc = Document::from(
            r#"<article><div id="related-title"><blockquote class="twitter-tweet">
            <a href="https://x.com/user/status/123">引用</a></blockquote></div>
            <ul class="manual-related"><li><a href="/a">別一</a></li><li><a href="/b">別二</a></li><li><a href="/c">別三</a></li></ul></article>"#,
        );
        prune(&doc, "https://blog.example/post");
        assert!(doc.select("#related-title blockquote").exists());
    }

    #[test]
    fn keeps_the_header_in_a_structured_article_and_adjacent_embeds_under_main() {
        let body = r#"<main><div id="embed"><blockquote class="twitter-tweet"><a href="https://x.com/user/status/123">本文の引用</a></blockquote></div>
            <div id="body" itemprop="articleBody">本文</div></main>"#;
        let base = "https://blog.example/post";
        let page = Document::from(body);
        assert_eq!(leading_embeds(&page.select("#body"), base).len(), 1);

        let structured = body
            .replace(
                "<main>",
                r#"<div itemscope itemtype="https://schema.org/BlogPosting">"#,
            )
            .replace("</main>", "</div>")
            .replace(r#"<div id="embed">"#, "<header>")
            .replace("</blockquote></div>", "</blockquote></header>");
        let page = Document::from(structured);
        let leading = leading_embeds(&page.select("#body"), base);
        assert_eq!(leading.len(), 1);
        assert!(leading[0].is("header"));
    }

    #[test]
    fn keeps_a_lead_in_the_same_section_as_the_article_body() {
        let doc = Document::from(
            r#"<main><section><blockquote class="twitter-tweet"><a href="https://x.com/user/status/456">別の記事</a></blockquote></section>
            <section><blockquote class="twitter-tweet"><a href="https://x.com/user/status/123">本文の引用</a></blockquote>
            <div id="body" itemprop="articleBody">本文</div></section></main>"#,
        );
        let lead = leading_embeds(&doc.select("#body"), "https://blog.example/post");
        assert_eq!(lead.len(), 1);
        assert!(lead[0].text().contains("本文の引用"));
    }

    #[test]
    fn uses_the_explicit_article_as_the_boundary_of_an_article_body() {
        let dom = r#"<main><section><blockquote class="twitter-tweet"><a href="https://x.com/user/status/123">別の記事</a></blockquote></section><div id="body" itemprop="articleBody">本文</div></main>"#;
        let doc = Document::from(dom);
        assert!(leading_embeds(&doc.select("#body"), "https://blog.example/post").is_empty());

        let within_article = Document::from(dom.replace("main", "article"));
        assert_eq!(
            leading_embeds(&within_article.select("#body"), "https://blog.example/post").len(),
            1
        );
    }

    #[test]
    fn does_not_confine_body_to_a_header_only_article() {
        let html = format!(
            "<title>表紙だけが article の記事</title><article><h1>表紙だけが article の記事</h1><img src='/cover.jpg'></article><div>{}</div>",
            paragraphs()
        );
        let result = extract(&html, "https://unseen.example/post").unwrap();
        assert!(result.html.contains("本文の段落0"));
        assert!(result.html.contains("本文の段落5"));
    }
    #[test]
    fn article_body_excludes_long_campaign_outside_article() {
        let html = format!(
            "<title>検証用の記事の見出し</title><main><article><h1>検証用の記事の見出し</h1>{}</article><section><h2>イベントの宣伝</h2><p>{}</p></section></main>",
            paragraphs(),
            "無関係のセミナーへ参加してください。".repeat(200)
        );
        let result = extract(&html, "https://other.example/post").unwrap();
        assert!(!result.html.contains("無関係のセミナー"));
        assert!(result.html.contains("本文の段落5"));
    }
    #[test]
    fn does_not_stop_at_a_header_with_a_short_lead() {
        let html = format!(
            "<title>別ブロックに続く本文の見出し</title><article><h1>別ブロックに続く本文の見出し</h1><p>この記事の短い導入文は見出しのすぐ下にあります。ここには表紙と記事の概要だけを載せています。</p></article><div>{}</div>",
            paragraphs()
        );
        let result = extract(&html, "https://different.example/post").unwrap();
        assert!(result.html.contains("本文の段落5"));
    }
    #[test]
    fn keeps_heading_lead_and_cover_adjacent_to_semantic_body() {
        let html = format!(
            "<title>別ブロックに分かれた記事</title><main><header><h1>別ブロックに分かれた記事</h1><p>この短い導入も本文の一部です。</p></header><figure><a href='/photo/view'><img src='/cover.jpg'></a><figcaption>表紙の説明</figcaption></figure><section itemprop='articleBody'>{}</section></main><aside>長い著者紹介</aside>",
            paragraphs()
        );
        let result = extract(&html, "https://unknown.example/post").unwrap();
        assert!(result.html.contains("別ブロックに分かれた記事"));
        assert!(result.html.contains("この短い導入も本文の一部"));
        assert!(result.html.contains("https://unknown.example/cover.jpg"));
        assert!(result.html.contains("https://unknown.example/photo/view"));
        assert!(result.html.contains("表紙の説明"));
        assert!(result.html.contains("本文の段落5"));
        assert!(!result.html.contains("長い著者紹介"));
    }
    #[test]
    fn extracts_list_only_articles_without_div_wrappers() {
        let items: String = (0..5).map(|i|format!("<li>箇条書きの項目{i}です。これは説明をリスト形式で伝える記事で、段落の要素は使っていません。調べた結果を読みやすく順番に並べています。</li>")).collect();
        let result = extract(&format!("<title>リスト形式の記事</title><main><article><h1>リスト形式の記事</h1><ul>{items}</ul></article></main>"), "https://new.example/post").unwrap();
        assert!(result.html.contains("箇条書きの項目0"));
        assert!(result.html.contains("箇条書きの項目4"));
        assert!(result.html.contains("<ul>"));
        assert_eq!(Document::from(result.html).select("li").length(), 5);
    }
    #[test]
    fn extracts_a_plain_text_body_without_block_wrappers() {
        let text = "これは文章だけで構成した記事です。段落のタグがなくても、取り込んだ文章を途中で捨てないようにします。".repeat(8);
        let result = extract(
            &format!("<title>文章の記事</title><body>{text}</body>"),
            "https://plain.example/post",
        )
        .unwrap();
        assert!(result.html.contains(&text));
    }
    #[test]
    fn does_not_expand_an_article_to_the_site_header_logo() {
        let html = format!(
            "<title>本文を残す検証用の見出し</title><header><img src='/site-logo.png'></header><article><h1>本文を残す検証用の見出し</h1>{}</article>",
            paragraphs()
        );
        let result = extract(&html, "https://another.example/post").unwrap();
        assert!(result.html.contains("本文の段落5"));
        assert!(!result.html.contains("site-logo.png"));
    }
}
