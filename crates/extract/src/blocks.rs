//! 全 body を残した DOM から、本文の手掛かりを集め、その共通の領域を残す。
//!
//! 抽出器が作り直した HTML を配らない。元の DOM を使うので、段落間の画像・リンク・導入文を
//! 保てる。ホスト名やサイト別のセレクタは使わない。
use dom_query::{Document, NodeRef, Selection};

use crate::{ExtractError, Extracted};

const BODY_BLOCKS: &str =
    "p, pre, td, th, blockquote, div, section, article, main, body, li, dt, dd";

fn compact(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

fn prune(doc: &Document) {
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
        if (20..240).contains(&text)
            && link_text * 10 >= text * 9
            && (links.length() >= 3 || block.select("img").length() > 0)
            && block.select("figure, p, pre, table").length() == 0
        {
            block.remove();
        }
    }
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
    prune(&doc);
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

    let (mut root, best_size) =
        choose_root(&doc, &seed, semantic).ok_or(ExtractError::NoContent)?;
    // 同じ記事の見出しと導入画像が隣のブロックに分かれている場合は、一緒に残す。
    // 広げた親のうち、本文より後ろの兄弟（メールマガジンの案内、おすすめ記事、広告など）は残さない。
    // 本文の続きの文章がそこにあれば、手掛かりの多い親が最初から選ばれている。
    // 画像のブロックは手掛かりを持たないので、後ろにあっても残す。
    let title_key = compact(&page_title);
    let has_heading = root.select("h1").length() > 0;
    let image_block = |block: &Selection| {
        matches!(
            block.nodes()[0].node_name().as_deref(),
            Some("header" | "figure" | "picture")
        ) && block.select("img").length() > 0
            && compact(&block.text()).chars().count() <= 200
    };
    let mut branch = root.nodes()[0].id;
    for node in root.ancestors(Some(3)).nodes() {
        let parent = Selection::from(*node);
        let trailing: Vec<_> = parent
            .children()
            .nodes()
            .iter()
            .skip_while(|child| child.id != branch)
            .skip(1)
            .filter(|child| !image_block(&Selection::from(**child)))
            .copied()
            .collect();
        let trailing_size: usize = trailing
            .iter()
            .map(|child| compact(&Selection::from(*child).text()).chars().count())
            .sum();
        let size = compact(&parent.text())
            .chars()
            .count()
            .saturating_sub(trailing_size);
        let heading = compact(&parent.select("h1").first().text());
        let content_parent = matches!(node.node_name().as_deref(), Some("article" | "main"))
            || parent.attr("role").as_deref() == Some("main");
        let lead_image = content_parent
            && parent
                .children()
                .nodes()
                .iter()
                .any(|sibling| image_block(&Selection::from(*sibling)));
        if size <= best_size * 3 / 2
            && ((!has_heading && heading.chars().count() >= 5 && title_key.contains(&heading))
                || lead_image)
        {
            for child in trailing {
                Selection::from(child).remove();
            }
            root = parent;
            break;
        }
        branch = node.id;
    }
    // 相対 URL はリダイレクト後の記事 URL を基準にする。HTML の base タグは信用しない。
    for node in root.select("a[href], img[src]").nodes() {
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
    drop_repeated_images(&root);
    let html = root.html().to_string();
    let text_length = root.text().trim().chars().count();
    if text_length == 0 {
        return Err(ExtractError::NoContent);
    }
    Ok(Extracted {
        title: title.trim().to_owned(),
        html,
        text_length,
    })
}

/// 同じ URL の画像が 2 回以上出るときは、最初の 1 枚だけを残す（docs/decisions/content.md の 19）。
/// 画面幅ごとに同じ表紙を出し分けるページでは、CSS を読まないので同じ画像が続けて残る。
/// 画像だけを入れていたリンクが空になったら、リンクも落とす。文の中の画像（親の要素に文字が
/// 直接ある。絵文字など）は、書き手がくり返しているので残し、数えもしない。URL は絶対にしたあとで比べる。
fn drop_repeated_images(root: &Selection) {
    let mut seen = std::collections::HashSet::new();
    for node in root.select("img[src]").nodes() {
        let Some(parent) = node.parent() else {
            continue;
        };
        let in_text = parent
            .children_it(false)
            .any(|child| child.is_text() && !child.text().trim().is_empty());
        if in_text {
            continue;
        }
        let image = Selection::from(*node);
        let Some(src) = image.attr("src") else {
            continue;
        };
        if seen.insert(src.to_string()) {
            continue;
        }
        image.remove();
        let link = Selection::from(parent);
        if parent.node_name().as_deref() == Some("a")
            && link.select("img").length() == 0
            && compact(&link.text()).is_empty()
        {
            link.remove();
        }
    }
}

/// 元の DOM の段落を、抽出器が抜いた文章（seed）と照合して手掛かりを集め、本文の範囲を選ぶ。
/// 意味的な領域（semantic）があれば、その中だけで集め、その領域を本文にする。
/// 選んだ要素と、その文字数を返す。手掛かりがなければ None
fn choose_root<'a>(
    doc: &'a Document,
    seed: &str,
    semantic: Option<NodeRef<'a>>,
) -> Option<(Selection<'a>, usize)> {
    let mut anchors = Vec::new();
    // 手掛かりと同じ形（文章で、リンクが半分以下）なのに、抽出器の文章と一致しなかった段落。
    // 抽出器が拾い損ねた本文のことがあるので、範囲を選ぶときに減点しない。
    let mut prose = Vec::new();
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
            anchors.push((*node, len.min(200), len));
        } else if prose.len() < 2048 {
            prose.push((*node, len));
        }
        if anchors.len() == 512 {
            break;
        }
    }
    let total: usize = anchors.iter().map(|(_, weight, _)| weight).sum();
    if total == 0 && semantic.is_none() {
        return None;
    }

    // 要素ごとに、含む手掛かりの重みと文字数、拾い損ねたかもしれない段落の文字数を数える。
    let mut candidates = std::collections::HashMap::new();
    for (anchor, weight, len) in &anchors {
        let ancestors = Selection::from(*anchor).ancestors(Some(128));
        for node in std::iter::once(anchor).chain(ancestors.nodes()) {
            let candidate = candidates
                .entry(node.id)
                .or_insert((0usize, 0usize, 0usize));
            candidate.0 += weight;
            candidate.1 += len;
        }
    }
    for (block, len) in &prose {
        for node in Selection::from(*block).ancestors(Some(128)).nodes() {
            if let Some(candidate) = candidates.get_mut(&node.id) {
                candidate.2 += len;
            }
        }
    }
    // 抽出器の文章には、記事の外（フッターの著作権表示やメールマガジンの案内など）が混じることがある。
    // 手掛かりをすべて含む要素を選ぶと、外の手掛かり 1 つでページ全体に広がるので、手掛かりの重みの
    // 半分以上を含む要素の中から、手掛かりの文字が、それ以外の文字（メニューや広告の見出し、共有の
    // ボタンなど、リンクや短い断片）より最も多く勝る要素を選ぶ。手掛かりと同じ形の段落は、抽出器が
    // 拾い損ねた本文のことがあるので減点しない。半分に満たない要素を選ばないのも、抽出器が本文の
    // 一部しか拾えなかったときに、本文を削らないため。
    // 意味的な領域があれば、それを本文にする（手掛かりはその中だけで集めている）。
    let mut best = semantic.map(Selection::from);
    let mut best_size = best
        .as_ref()
        .map(|s| compact(&s.text()).chars().count())
        .unwrap_or(0);
    let mut best_score = i64::MIN;
    // 文書の順に評価し、同じ値なら外側を残す。画像しかない隣接ブロックも保持する。
    let nodes = if semantic.is_some() {
        Vec::new()
    } else {
        doc.select("body, main, article, section, div, [role=main]")
            .nodes()
            .to_vec()
    };
    for node in &nodes {
        let Some((weight, anchored, prose)) = candidates.get(&node.id) else {
            continue;
        };
        if weight * 2 < total {
            continue;
        }
        let block = Selection::from(*node);
        let size = compact(&block.text()).chars().count();
        let count = |n: usize| i64::try_from(n).unwrap_or(i64::MAX / 4);
        let score = 2 * count(*anchored) + count(*prose) - count(size);
        if score > best_score {
            best = Some(block);
            best_size = size;
            best_score = score;
        }
    }
    best.map(|block| (block, best_size))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn paragraphs() -> String {
        (0..6).map(|i|format!("<p>本文の段落{i}には調査の経緯と結果を書きます。読み手に必要な詳しい説明を順に並べ、途中に置かれた写真と最後の結論まで伝える記事です。</p>")).collect()
    }
    #[test]
    fn ignores_matched_text_outside_the_article() {
        // おすすめ記事やメニューは、実際のページと同じくリンクの見出しの並びにする。
        let recommended: String = (0..6)
            .map(|i| format!("<li><a href='/recommend/{i}'>おすすめの記事{i}の見出しです。ほかの話題について読めます</a></li>"))
            .collect();
        let menu: String = (0..6)
            .map(|i| format!("<li><a href='/category/{i}'>記事の分類{i}の一覧を開きます</a></li>"))
            .collect();
        let html = format!(
            "<title>記事</title><body><div id='menu'><ul>{menu}</ul></div><div id='page'><div class='body'>{}</div><div class='nl'><p>この記事を毎朝メールでまとめて読めます（無料）</p><p>メールマガジンを申し込む</p></div><div class='recommend'><ul>{recommended}</ul></div></div><div id='foot'><p>このサイトは、ライセンスに基づいて運営会社が運営しています。</p><p>当サイトは最新のブラウザーでの閲覧をおすすめします。</p></div></body>",
            paragraphs()
        );
        let doc = Document::from(html);
        let seed = compact(&format!(
            "{}この記事を毎朝メールでまとめて読めます（無料）このサイトは、ライセンスに基づいて運営会社が運営しています。当サイトは最新のブラウザーでの閲覧をおすすめします。",
            doc.select(".body").text()
        ));
        let (root, _) = choose_root(&doc, &seed, None).unwrap();
        assert_eq!(root.attr("class").as_deref(), Some("body"));
    }
    #[test]
    fn keeps_a_body_whose_paragraphs_the_extractor_partly_missed() {
        let missed: String = (0..6)
            .map(|i| format!("<p>抽出器が拾わなかった段落{i}です。リンクの多い説明や短い補足が続き、手掛かりにはなりませんが本文の一部です。</p>"))
            .collect();
        let html = format!(
            "<title>記事</title><body><div class='article'><div class='lead'><p>最初の段落です。記事の導入として、このあとの本文で扱う内容をまとめて伝えます。</p><p>二つめの段落です。導入の続きとして、背景と問題の大きさを説明しています。</p></div><div class='rest'><p>本文の後半の段落です。調べた結果と、そこから分かったことを順に書いています。</p><p>本文の後半の二つめの段落です。結果の意味と、残った課題について書いています。</p><p>本文の最後の段落です。まとめとして、これから確かめることを書いています。</p>{missed}</div></div></body>"
        );
        let doc = Document::from(html);
        // 後半から照合できるのが 1 段落だけで、手掛かりの過半数が前半にあっても、後半を残す。
        let seed = compact(&doc.select(".lead").text())
            + &compact(&doc.select(".rest > p:nth-child(1)").text());
        assert!(!seed.contains("抽出器が拾わなかった"));
        let (root, _) = choose_root(&doc, &seed, None).unwrap();
        let text = root.text();
        assert!(text.contains("最初の段落です"));
        assert!(text.contains("本文の最後の段落です"));
        assert!(text.contains("抽出器が拾わなかった段落5"));
    }
    #[test]
    fn expands_to_the_heading_without_the_blocks_after_the_body() {
        let html = format!(
            "<title>見出しが別のブロックにある記事 | サイト</title><body><div id='column'><div class='head'><h1>見出しが別のブロックにある記事</h1></div><div class='inner'><div class='body'>{}</div></div><div class='recommend'><p>あなたにおすすめの記事として、ほかの話題の長い紹介文を並べています。</p></div><div class='promo'><p>企画広告の紹介です。製品を使うと仕事がもっと楽になると説明しています。</p></div></div><div id='foot'><p>Copyright のような、サイトの運営についての文がここに入ります。</p></div></body>",
            paragraphs()
        );
        let result = extract(&html, "https://column.example/post").unwrap();
        assert!(result.html.contains("見出しが別のブロックにある記事"));
        assert!(result.html.contains("本文の段落0"));
        assert!(result.html.contains("本文の段落5"));
        assert!(!result.html.contains("あなたにおすすめ"));
        assert!(!result.html.contains("企画広告"));
        assert!(!result.html.contains("Copyright"));
    }
    #[test]
    fn keeps_an_image_block_after_the_semantic_body() {
        let html = format!(
            "<title>本文の後ろに写真がある記事</title><main><article><h1>本文の後ろに写真がある記事</h1>{}</article><figure><img src='/after.jpg'><figcaption>本文の後ろの写真の説明</figcaption></figure></main>",
            paragraphs()
        );
        let result = extract(&html, "https://figure.example/post").unwrap();
        assert!(result.html.contains("本文の段落5"));
        assert!(result.html.contains("https://figure.example/after.jpg"));
        assert!(result.html.contains("本文の後ろの写真の説明"));
    }
    #[test]
    fn keeps_only_the_first_of_images_with_the_same_url() {
        let html = format!(
            "<title>表紙が二回ある記事</title><div><div><img src='/cover.jpg'></div><h1>表紙が二回ある記事</h1><div><img src='https://cover.example/cover.jpg'></div><div>{}<p><img src='/other.jpg'></p></div></div>",
            paragraphs()
        );
        let result = extract(&html, "https://cover.example/post").unwrap();
        let doc = Document::from(result.html);
        assert_eq!(
            doc.select("img[src='https://cover.example/cover.jpg']")
                .length(),
            1
        );
        assert_eq!(
            doc.select("img[src='https://cover.example/other.jpg']")
                .length(),
            1
        );
        assert!(doc.text().contains("表紙が二回ある記事"));
        assert!(doc.text().contains("本文の段落5"));
        // 残るのは最初の 1 枚（見出しの前）
        let html = doc.html().to_string();
        assert!(html.find("cover.jpg").unwrap() < html.find("表紙が二回ある記事").unwrap());
    }
    #[test]
    fn compares_image_urls_after_normalizing_them() {
        let html = format!(
            "<title>遅延読み込みの記事</title><div><h1>遅延読み込みの記事</h1>{}<figure><img src='/cover.jpg'></figure><figure><img src='/loading.gif' data-src='https://lazy.example/cover.jpg'></figure><figure><img srcset='/cover.jpg 800w'></figure></div>",
            paragraphs()
        );
        // 遅延読み込みと srcset の正規化は、入口（crate::extract）で行う。
        let result = crate::extract(html.as_bytes(), None, "https://lazy.example/post").unwrap();
        let doc = Document::from(result.html);
        assert_eq!(doc.select("img").length(), 1);
    }
    #[test]
    fn drops_a_link_left_empty_by_a_repeated_image() {
        let html = format!(
            "<title>リンクの写真が重なる記事</title><div><h1>リンクの写真が重なる記事</h1><figure><img src='/photo.jpg'></figure>{}<p><a href='/view' id='only-photo'><img src='/photo.jpg'></a></p><p><a href='/more'><span>写真の詳しい説明はこちら</span><img src='/photo.jpg'></a></p></div>",
            paragraphs()
        );
        let result = extract(&html, "https://link.example/post").unwrap();
        let doc = Document::from(result.html);
        assert_eq!(doc.select("img").length(), 1);
        assert_eq!(
            doc.select("a[href='https://link.example/view']").length(),
            0
        );
        assert_eq!(
            doc.select("a[href='https://link.example/more']").length(),
            1
        );
        assert!(doc.text().contains("写真の詳しい説明はこちら"));
    }
    #[test]
    fn keeps_repeated_images_inside_text() {
        let html = format!(
            "<title>絵文字のある記事</title><div><h1>絵文字のある記事</h1>{}<p>とてもよい<img src='/emoji.png'>記事でした<img src='/emoji.png'>またね</p></div>",
            paragraphs()
        );
        let result = extract(&html, "https://emoji.example/post").unwrap();
        let doc = Document::from(result.html);
        assert_eq!(
            doc.select("img[src='https://emoji.example/emoji.png']")
                .length(),
            2
        );
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
