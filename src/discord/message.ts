import { escapeHtml } from "../lib/html";
import { truncateUtf16 } from "../lib/text";

/*
 * Discord の投稿を、記事のタイトル、要約、本文の HTML にする（docs/decisions/discord.md の 6）。
 *
 * 本文は、テキストのあとに、埋め込みごとに作者の名前、タイトル（URL があればそのリンク）、説明、
 * フィールドの名前と値、フッターの文字を並べる。Markdown とメッセージの書式（メンションなど）は
 * 解釈せず、文字のまま出す。改行は保ち、http ／ https の URL はリンクにする。
 * 埋め込みの画像、サムネイル、動画は使わない。
 *
 * 埋め込みは Discord から来た形のまま受け取り、値ごとに型を確かめる。形の違う値は、その値だけを
 * 使わない（ほかの値と、ほかの投稿の取り込みは止めない）。返す HTML は、置く前にサニタイズする。
 */

/** テキストのない投稿のタイトル */
export const DISCORD_FALLBACK_TITLE = "Discord の投稿";
const MAX_TITLE_LENGTH = 120;
/** 改行（CRLF、LF、CR だけ） */
const NEWLINE = /\r\n?|\n/;

export type DiscordPost = {
  title: string;
  summary: string | null;
  /** 本文にする HTML（サニタイズする前）。テキストも埋め込みの文字もなければ null */
  html: string | null;
};

type EmbedText = {
  author: string;
  title: string;
  url: string;
  description: string;
  fields: { name: string; value: string }[];
  footer: string;
};

export function toDiscordPost(message: {
  content: string;
  embeds: readonly unknown[];
}): DiscordPost {
  const text = message.content.trim();
  const embeds = message.embeds.map(readEmbed);
  const blocks = [
    ...(text ? [paragraphs(text)] : []),
    ...embeds.map(embedHtml).filter((html) => html !== ""),
  ];
  const html = blocks.length > 0 ? blocks.join("") : null;
  if (text) return { title: firstLine(text), summary: text, html };

  const lead = embeds.find((embed) => embed.title || embed.description);
  if (!lead) return { title: DISCORD_FALLBACK_TITLE, summary: null, html };
  return {
    title: firstLine(lead.title || lead.description),
    summary: lead.description || null,
    html,
  };
}

function firstLine(text: string): string {
  const line = text.split(NEWLINE, 1)[0]?.trim() ?? "";
  return truncateUtf16(line, MAX_TITLE_LENGTH) || DISCORD_FALLBACK_TITLE;
}

function readEmbed(embed: unknown): EmbedText {
  const value = record(embed);
  const fields = Array.isArray(value.fields) ? value.fields : [];
  return {
    author: string(record(value.author).name),
    title: string(value.title),
    url: string(value.url),
    description: string(value.description),
    fields: fields
      .map((field) => ({ name: string(record(field).name), value: string(record(field).value) }))
      .filter((field) => field.name || field.value),
    footer: string(record(value.footer).text),
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function embedHtml(embed: EmbedText): string {
  const parts: string[] = [];
  if (embed.author) parts.push(`<p><small>${inline(embed.author)}</small></p>`);
  if (embed.title) {
    const title = inline(embed.title);
    const url = httpUrl(embed.url);
    parts.push(
      `<p><strong>${url ? `<a href="${escapeHtml(url)}">${title}</a>` : title}</strong></p>`,
    );
  }
  if (embed.description) parts.push(paragraphs(embed.description));
  if (embed.fields.length > 0) {
    const items = embed.fields.map(
      (field) => `<dt>${inline(field.name)}</dt><dd>${inline(field.value)}</dd>`,
    );
    parts.push(`<dl>${items.join("")}</dl>`);
  }
  if (embed.footer) parts.push(`<p><small>${inline(embed.footer)}</small></p>`);
  return parts.length > 0 ? `<blockquote>${parts.join("")}</blockquote>` : "";
}

function httpUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value)) return null;
  return URL.canParse(value) ? value : null;
}

/** 空行で段落に分け、段落の中の改行は <br> にする */
function paragraphs(text: string): string {
  return text
    .split(/(?:\r\n?|\n)[ \t]*(?:\r\n?|\n)/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => `<p>${inline(paragraph)}</p>`)
    .join("");
}

/** 文字をエスケープし、改行を <br> に、http ／ https の URL をリンクにする */
function inline(text: string): string {
  return text.split(NEWLINE).map(linkify).join("<br>");
}

const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;

function linkify(line: string): string {
  let html = "";
  let last = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    const start = match.index;
    html += escapeHtml(line.slice(last, start));
    html += URL.canParse(url)
      ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
      : escapeHtml(url);
    last = start + url.length;
  }
  return html + escapeHtml(line.slice(last));
}

/** URL の後ろに続いた句読点と、対応する「(」のない「)」を外す */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last && ".,;:!?'*_~|`".includes(last)) {
      end--;
      continue;
    }
    if (last === ")") {
      const head = url.slice(0, end);
      const opens = head.split("(").length - 1;
      const closes = head.split(")").length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    return url.slice(0, end);
  }
}
