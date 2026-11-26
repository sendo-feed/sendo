import {
  type CreatedNotification,
  findBellHits,
  findClosedWindows,
  insertArticleNotifications,
  insertBundleNotification,
  MAX_BUNDLES_PER_JOB,
  type PushDelivery,
  readBundledArticles,
  readPushDelivery,
} from "../db/bell-notifications";
import { countUnreadByFeed } from "../db/inbox";
import { deletePushRegistrationById, listPushRegistrations } from "../db/push-registrations";
import { parseRetryAfter } from "../fetcher/fetch-feed";
import { toFetchableUrl, UrlNotAllowedError } from "../fetcher/url-guard";
import { loggableError } from "../lib/log-error";
import { type BellNotification, BUNDLE_LINES, buildNotificationPayload } from "../notify/payload";
import { vapidAuthorization } from "../notify/vapid";
import { encryptPushMessage } from "../notify/web-push";
import type { Platform } from "../platform";

/*
 * ベルの通知（docs/decisions/notifications.md の 8〜13、21、22）。取得の仕事が、取り込んだ記事を
 * 判定して通知の行を作り、送る行なら端末ごとに送る仕事を積む。送る仕事は、送るときに中身を
 * 組み立てて、Web Push で送る。
 */

/** 1 回の取得の仕事で判定する記事の数。公開日時の新しい順に選ぶ */
const MAX_JUDGED_ARTICLES = 50;

/** 送るときの時間切れ（応答を受け終えるまで。docs/decisions/images.md の 3 と同じ） */
const PUSH_TIMEOUT_MS = 15_000;

/** プッシュサービスが、届けられない通知を持っておく長さ（秒） */
const PUSH_TTL_SECONDS = 12 * 60 * 60;

/** 429 ／ 503 の Retry-After がこれより先なら、やり直さずに諦める（やり直しは 1 分おき） */
const MAX_RETRY_AFTER_MS = 60 * 1000;

/** 取得の仕事が行を入れた記事 */
export type IngestedArticle = {
  id: string;
  /** 記事の行の公開日時。フィードに日付がなければ、取得の時刻 */
  publishedAt: Date;
  /** フィードに日付があったか。なければ、取り込んだ時刻を公開日時とみなす */
  dated: boolean;
};

/**
 * 取得の仕事が行を入れた記事を判定し、当たったら通知の行を作って、送る仕事を積む。受信箱に
 * 配ったあとに呼ぶ。
 *
 * - Web Push が使えない設定なら、何もしない
 * - 判定する記事は、公開日時の新しい順に 50 件まで。行は、公開日時の古い順に 1 件ずつ作る
 * - 判定や積むのに失敗しても、取得の仕事は失敗にしない（その回の通知は出ないことがある）
 *
 * @param previousSuccessAt 今回より前に、このフィードの取得に最後に成功した時刻
 */
export async function notifyBells(
  platform: Pick<Platform, "db" | "jobs" | "push">,
  input: { previousSuccessAt: Date | null; articles: readonly IngestedArticle[] },
): Promise<void> {
  const { previousSuccessAt } = input;
  if (!platform.push || previousSuccessAt === null || input.articles.length === 0) return;
  try {
    const judged = [...input.articles]
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, MAX_JUDGED_ARTICLES)
      .reverse();
    const hits = await findBellHits(platform.db, {
      articleIds: judged.map((article) => article.id),
      previousSuccessAt,
    });
    for (const article of judged) {
      const found = hits.filter((hit) => hit.articleId === article.id);
      if (found.length === 0) continue;
      const created = await insertArticleNotifications(platform.db, {
        articleId: article.id,
        publishedAt: article.dated ? article.publishedAt : null,
        hits: found,
      });
      await enqueueSends(platform, created);
    }
  } catch (error) {
    console.error("could not notify bells", { error: loggableError(error) });
  }
}

/**
 * 閉じた窓を拾い、窓ごとにまとめの行を作って、送る行なら端末ごとに送る仕事を積む（docs/decisions/
 * notifications.md の 13）。定期実行が 5 分おきに積む。1 回に拾う窓は 100 個まで。まとめの行を作って
 * から積む前に落ちたら、そのまとめは出ない（窓にまとめの行があるので、拾い直さない）
 */
export async function runBundleBellNotifications(
  platform: Pick<Platform, "db" | "jobs" | "push">,
): Promise<void> {
  if (!platform.push) return;
  for (const window of await findClosedWindows(platform.db, MAX_BUNDLES_PER_JOB)) {
    const created = await insertBundleNotification(platform.db, window);
    if (created) await enqueueSends(platform, [created]);
  }
}

/** 作った行のうち sent のものについて、その人の端末ごとに送る仕事を積む */
async function enqueueSends(
  platform: Pick<Platform, "db" | "jobs">,
  created: readonly CreatedNotification[],
): Promise<void> {
  const sent = created.filter((row) => row.state === "sent");
  if (sent.length === 0) return;
  const registrations = await listPushRegistrations(platform.db, [
    ...new Set(sent.map((row) => row.userId)),
  ]);
  const jobs = sent.flatMap((row) =>
    registrations
      .filter((registration) => registration.userId === row.userId)
      .map((registration) => ({
        type: "send-bell-notification" as const,
        notificationId: row.id,
        registrationId: registration.id,
      })),
  );
  if (jobs.length > 0) await platform.jobs.enqueue(jobs);
}

/**
 * 通知の行 1 つを、端末 1 つに送る。中身は送るときに組み立てる。登録の行がもうない、セッションの
 * 期限が切れた、ベルが外された、のどれかなら送らない。
 *
 * - 404 ／ 410、内部のアドレス：登録を行の ID で消し、やり直さない
 * - 429 ／ 503 で Retry-After が 1 分より先：やり直さずに諦める
 * - そのほかの 429、5xx、つながらない、時間切れ：例外を投げ、仕事の表がやり直す
 * - 3xx とそのほかの 4xx：やり直さず、状態コードをログに出す
 *
 * エンドポイントと鍵は秘密なので、ログに出さない
 */
export async function runSendBellNotification(
  platform: Pick<Platform, "db" | "fetch" | "now" | "push">,
  job: { notificationId: string; registrationId: string },
): Promise<void> {
  const { db, push } = platform;
  if (!push) return;
  const delivery = await readPushDelivery(db, { ...job, now: platform.now() });
  if (!delivery) return;
  const content = await loadContent(platform, delivery);
  if (!content) return;

  let endpoint: URL;
  try {
    endpoint = toFetchableUrl(delivery.registration.endpoint);
  } catch (error) {
    if (!(error instanceof UrlNotAllowedError)) throw error;
    await deletePushRegistrationById(db, job.registrationId);
    return;
  }
  const payload = buildNotificationPayload(content, push.readerOrigin);
  const body = await encryptPushMessage(new TextEncoder().encode(payload), delivery.registration);
  const authorization = await vapidAuthorization(db, {
    subject: push.subject,
    endpoint: endpoint.href,
    now: platform.now(),
  });

  let response: Response;
  try {
    response = await platform.fetch(endpoint, {
      method: "POST",
      headers: {
        authorization,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(PUSH_TTL_SECONDS),
        urgency: "high",
      },
      body,
      // プッシュサービスはリダイレクトさせない。追えば、確かめていない先へ送る道になる
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    // 応答の本文は使わない。読まずに閉じる
    await response.body?.cancel();
  } catch (error) {
    if (connectsToPrivateAddress(error)) {
      await deletePushRegistrationById(db, job.registrationId);
      return;
    }
    throw error;
  }

  const { status } = response;
  if (status >= 200 && status < 300) return;
  if (status === 404 || status === 410) {
    await deletePushRegistrationById(db, job.registrationId);
    return;
  }
  if (status === 429 || status === 503) {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"), {
      date: response.headers.get("date"),
      now: platform.now(),
    });
    if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) {
      console.warn("push service asked to wait too long; giving up", { status, retryAfter });
      return;
    }
  }
  if (status === 429 || status >= 500) throw new Error(`push service answered ${status}`);
  console.warn("push service refused the notification", { status });
}

/** 緩衝層の fetch が、内部のアドレスに解決された宛先につながなかった（platform/node/safe-fetch.ts） */
function connectsToPrivateAddress(error: unknown): boolean {
  const cause = error instanceof TypeError ? error.cause : error;
  return cause instanceof Error && "code" in cause && cause.code === "ERR_PRIVATE_ADDRESS";
}

/**
 * 通知の行から、通知の中身を組み立てる。記事の行はその記事、まとめの行は窓の bundled の記事
 * （新しい順に 3 件と、まとめた数）。まとめる記事がもうなければ undefined
 */
async function loadContent(
  platform: Pick<Platform, "db">,
  delivery: PushDelivery,
): Promise<BellNotification | undefined> {
  const { db } = platform;
  const { count, articles } = delivery.article
    ? { count: 1, articles: [delivery.article] }
    : await readBundledArticles(db, { ...delivery, limit: BUNDLE_LINES });
  if (articles.length === 0) return undefined;
  const unread = [...(await countUnreadByFeed(db, delivery.userId)).values()].reduce(
    (sum, n) => sum + n,
    0,
  );
  return {
    bellId: delivery.bellId,
    words: null,
    feedName: feedName(delivery.feed),
    articles,
    count,
    unread,
  };
}

/** フィード名。購読の表示名、フィードの名前、フィードの URL のホストの順に、空でないものを使う */
function feedName(feed: PushDelivery["feed"]): string {
  const named = [feed.displayName, feed.title].find((name) => name && name.trim() !== "");
  return named ?? new URL(feed.url).host;
}
