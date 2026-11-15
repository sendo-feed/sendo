import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import { type Job, jobSchema } from "../../jobs/job";
import {
  type AuthConfig,
  type JobQueue,
  type OAuthServerConfig,
  type Platform,
  parseEmailList,
  parseOrigin,
} from "..";

/** Cloudflare の env から、アプリが使う Platform を組み立てる */
export function createCloudflarePlatform(env: Env): Platform {
  return {
    db: drizzle(env.DB, { schema }),
    jobs: createQueueJobQueue(env.JOBS),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    auth: readAuthConfig(env),
  };
}

/** 認証の設定に使う env の名前 */
type AuthEnvName =
  | "ALLOWED_EMAILS"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "PUBLIC_URL"
  | "READER_URL";

/**
 * ログインの設定を env から読む。秘密（メール、Google のクライアント）は、手元では .dev.vars、
 * 本番は wrangler secret put で入れる。設定していなければ、ブラウザのログインは使えない
 * （アクセストークンだけで使う）。
 *
 * OAuth（PUBLIC_URL と READER_URL）は秘密ではないので、wrangler.jsonc の vars に書く。
 * 2 つともあるときだけ使う。形が正しくなければ、エラーをログに出して OAuth を使わない
 */
export function readAuthConfig(env: Partial<Record<AuthEnvName, string>>): AuthConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return {
    allowedEmails: parseEmailList(env.ALLOWED_EMAILS),
    google: clientId && clientSecret ? { clientId, clientSecret } : undefined,
    oauth: readOAuthServerConfig(env),
  };
}

function readOAuthServerConfig(
  env: Partial<Record<AuthEnvName, string>>,
): OAuthServerConfig | undefined {
  try {
    const issuer = parseOrigin(env.PUBLIC_URL);
    const readerOrigin = parseOrigin(env.READER_URL);
    return issuer && readerOrigin ? { issuer, readerOrigin } : undefined;
  } catch (error) {
    console.error("OAuth is disabled: PUBLIC_URL and READER_URL must be https origins", error);
    return undefined;
  }
}

/**
 * Queues の sendBatch は、1 回に 100 件、合わせて 256KB まで
 * （https://developers.cloudflare.com/queues/platform/limits/）。余裕を持って分ける。
 */
const SEND_BATCH_MAX_MESSAGES = 100;
const SEND_BATCH_MAX_BYTES = 200 * 1024;

export function createQueueJobQueue(queue: Queue): JobQueue {
  return {
    async enqueue(jobs) {
      let batch: Job[] = [];
      let bytes = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        await queue.sendBatch(batch.map((body) => ({ body, contentType: "json" })));
        batch = [];
        bytes = 0;
      };
      for (const job of jobs) {
        const size = new TextEncoder().encode(JSON.stringify(job)).byteLength;
        if (batch.length >= SEND_BATCH_MAX_MESSAGES || bytes + size > SEND_BATCH_MAX_BYTES) {
          await flush();
        }
        batch.push(job);
        bytes += size;
      }
      await flush();
    },
  };
}

/**
 * キューから届いたメッセージを1件ずつ実行する。
 *
 * - 形の正しくないメッセージは、やり直しても直らないので捨てる
 * - 実行中の例外はやり直しに回す。max_retries を超えたら Queues が捨てる
 */
export async function handleQueueBatch(
  batch: MessageBatch,
  run: (job: Job) => Promise<void>,
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = jobSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error("dropping invalid job", { id: message.id, issues: parsed.error.issues });
      message.ack();
      continue;
    }
    try {
      await run(parsed.data);
      message.ack();
    } catch (error) {
      console.error("job failed; will retry", {
        id: message.id,
        attempts: message.attempts,
        error,
      });
      message.retry();
    }
  }
}
