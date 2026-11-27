import { describe, expect, it } from "vitest";
import { type BellNotification, buildNotificationPayload } from "../../src/notify/payload";

const READER = "https://reader.example.com";
const BELL = "8d1c5c6e-2f5e-4c4f-9a59-0c6c3ad1f7a1";
const ids = Array.from(
  { length: 12 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** 決定（docs/decisions/notifications.md の 14）の形の、期待する中身 */
function expected(input: {
  title: string;
  body: string;
  articleId: string;
  count: number;
  unread: number;
}) {
  return {
    web_push: 8030,
    notification: {
      title: input.title,
      body: input.body,
      navigate: `${READER}/?article=${input.articleId}`,
      tag: `bell:${BELL}:${input.articleId}`,
      data: { bellId: BELL, articleId: input.articleId, count: input.count },
    },
    app_badge: input.unread,
    mutable: true,
  };
}

const article = (index: number, title: string | null, summary: string | null = null) => ({
  id: ids[index] ?? "",
  title,
  summary,
});

function build(input: Partial<BellNotification>, origin = READER) {
  return buildNotificationPayload(
    {
      bellId: BELL,
      words: null,
      feedName: "Hacker News",
      articles: [article(0, "記事のタイトル")],
      count: 1,
      unread: 12,
      ...input,
    },
    origin,
  );
}

describe("通知の中身（Declarative Web Push）", () => {
  it("1 件の記事は、フィード名をタイトルに、記事のタイトルを本文にし、その記事を開く", () => {
    expect(JSON.parse(build({}))).toEqual(
      expected({
        title: "Hacker News",
        body: "記事のタイトル",
        articleId: ids[0] ?? "",
        count: 1,
        unread: 12,
      }),
    );
  });

  it("タイトルのない記事は、要約の先頭を本文にする", () => {
    const payload = JSON.parse(build({ articles: [article(0, null, "要約".repeat(150))] }));
    expect(payload.notification.body).toBe(`${"要約".repeat(100)}…`);
  });

  it("言葉のあるベルは、言葉とフィード名をタイトルにし、言葉だけのベルのまとめは言葉だけにする", () => {
    expect(JSON.parse(build({ words: "Azure 障害" })).notification.title).toBe(
      "Azure 障害 · Hacker News",
    );
    expect(JSON.parse(build({ words: "Azure 障害", feedName: null })).notification.title).toBe(
      "Azure 障害",
    );
  });

  it("まとめは、新しい順に 3 件までのタイトルを並べ、残りを「ほか n 件」にし、いちばん新しい記事を開く", () => {
    const articles = [article(5, "五"), article(4, "四"), article(3, "三")];

    expect(JSON.parse(build({ articles, count: 5 }))).toEqual(
      expected({
        title: "Hacker News",
        body: "五\n四\n三\nほか 2 件",
        articleId: ids[5] ?? "",
        count: 5,
        unread: 12,
      }),
    );
    expect(JSON.parse(build({ articles, count: 3 })).notification.body).toBe("五\n四\n三");
    expect(JSON.parse(build({ articles: [article(4, "四")], count: 1 })).notification.body).toBe(
      "四",
    );
  });

  it("フィード名は 80、タイトルは 200 コードポイントまで。ちょうどなら切らず、超えたら切って「…」を付ける", () => {
    // サロゲートペアの文字も 1 つと数える
    const at = (length: number) => "😀".repeat(length);
    const of = (feedName: string, title: string) =>
      JSON.parse(build({ feedName, articles: [article(0, title)] })).notification;

    expect(of(at(80), at(200))).toMatchObject({ title: at(80), body: at(200) });
    expect(of(at(81), at(201))).toMatchObject({ title: `${at(80)}…`, body: `${at(200)}…` });
  });

  it("フィード名とタイトルは、HTML として扱わず、文字のまま入れる", () => {
    const text = `<img src=x onerror="alert(1)"> &amp;  `;
    const payload = JSON.parse(build({ feedName: text, articles: [article(0, text)] }));
    expect(payload.notification).toMatchObject({ title: text, body: text });
  });
});

describe("3993 バイトに収める", () => {
  /**
   * JSON で 6 バイトになる文字（\u0001）と、1 バイトの文字と、2 バイトの文字を混ぜ、期待する中身の
   * JSON がちょうど bytes バイトになる、3 件のタイトルとフィード名を作る（どれも上限の長さ以内）
   */
  function sized(bytes: number) {
    const fields = [Array(200).fill("a"), Array(200).fill("a"), Array(200).fill("a")];
    const feed = Array(80).fill("a");
    const make = () => {
      const titles = fields.map((chars) => chars.join(""));
      const feedName = feed.join("");
      const articles = titles.map((title, i) => article(9 - i, title));
      const json = JSON.stringify(
        expected({
          title: feedName,
          body: `${titles.join("\n")}\nほか 7 件`,
          articleId: ids[9] ?? "",
          count: 10,
          unread: 12,
        }),
      );
      return { titles, feedName, articles, json };
    };
    const slots = [...fields, feed].flatMap((chars) => chars.map((_, i) => ({ chars, i })));
    let remaining = bytes - bytesOf(make().json);
    for (const { chars, i } of slots) {
      if (remaining >= 5) {
        chars[i] = "\u0001";
        remaining -= 5;
      } else if (remaining > 0) {
        chars[i] = "é";
        remaining -= 1;
      }
    }
    const result = make();
    expect(bytesOf(result.json)).toBe(bytes);
    return result;
  }

  it("ちょうど 3993 バイトなら、何も減らさない", () => {
    const { feedName, articles, json } = sized(3993);

    const payload = build({ feedName, articles, count: 10 });

    expect(bytesOf(payload)).toBe(3993);
    expect(JSON.parse(payload)).toEqual(JSON.parse(json));
  });

  it("3994 バイトなら、まとめに並べるタイトルを古いものから減らし、減らした分を「ほか n 件」に入れる", () => {
    const { titles, feedName, articles } = sized(3994);

    const payload = build({ feedName, articles, count: 10 });

    expect(bytesOf(payload)).toBeLessThanOrEqual(3993);
    expect(JSON.parse(payload).notification).toMatchObject({
      title: feedName,
      body: `${titles[0]}\n${titles[1]}\nほか 8 件`,
    });
  });

  it("並べるタイトルが 1 件でも超えるなら、記事のタイトルを半分ずつ切り、フィード名は残す", () => {
    // 送り先の URL が長いと、タイトルを並べなくても収まらない
    const origin = `https://${"r".repeat(3300)}.example`;
    const title = "あ".repeat(200);

    const payload = build({ feedName: "f".repeat(80), articles: [article(0, title)] }, origin);
    const { notification } = JSON.parse(payload);

    expect(bytesOf(payload)).toBeLessThanOrEqual(3993);
    expect(notification.title).toBe("f".repeat(80));
    expect(notification.body).toMatch(/^あ+…$/);
    expect(Array.from(notification.body).length - 1).toBe(50);
  });

  it("タイトルを切りきっても超えるなら、フィード名も半分ずつ切る", () => {
    const origin = `https://${"r".repeat(3500)}.example`;

    const payload = build(
      { feedName: "あ".repeat(80), articles: [article(0, "い".repeat(200))] },
      origin,
    );
    const { notification } = JSON.parse(payload);

    expect(bytesOf(payload)).toBeLessThanOrEqual(3993);
    expect(notification.body).toBe("…");
    expect(notification.title).toMatch(/^あ*…$/);
    expect(Array.from(notification.title).length - 1).toBeLessThan(80);
  });
});
