import { type ClientOptions, type RawData, WebSocket } from "ws";
import { z } from "zod";
import type { ChannelAddress, getDiscordGatewayInfo } from "../../discord/client";
import { FetchFeedError } from "../../fetcher/fetch-feed";
import { createGuardedLookup } from "./safe-fetch";

const GATEWAY = "wss://gateway.discord.gg/";
const STARTUP_TIMEOUT_MS = 30_000;
const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
const GUILD_MESSAGES = 1 << 9;
const IDENTIFY_INTERVAL_MS = 5_000;
const MAX_IDENTIFY_WAIT_MS = 24 * 60 * 60 * 1_000;

const payload = z.object({
  op: z.int(),
  d: z.unknown().optional(),
  s: z.int().nonnegative().nullish(),
  t: z.string().nullish(),
});
const hello = z.object({ heartbeat_interval: z.int().positive().max(120_000) });
const ready = z.object({ session_id: z.string().min(1), resume_gateway_url: z.string() });
const snowflake = z.string().regex(/^[1-9][0-9]{0,19}$/);
const message = z.object({ guild_id: snowflake, channel_id: snowflake });

interface GatewaySocket {
  on(event: "message", listener: (data: RawData) => void): void;
  on(event: "close", listener: (code: number) => void): void;
  on(event: "error", listener: () => void): void;
  send(data: string): void;
  terminate(): void;
}

type Session = { id: string; url: string; sequence: number };

function gatewayUrl(address: string): string {
  let url = new URL(GATEWAY);
  try {
    const candidate = new URL(address);
    if (
      candidate.protocol === "wss:" &&
      /^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(candidate.hostname) &&
      !candidate.username &&
      !candidate.password &&
      !candidate.port
    ) {
      url = new URL(candidate.origin);
    }
  } catch {
    // 既定の接続先から再開できる。
  }
  url.search = "?v=10&encoding=json";
  return url.href;
}

function readPayload(data: RawData) {
  try {
    const parsed = payload.safeParse(JSON.parse(data.toString()));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 同じ Bot で Gateway に接続し、チャンネルの新着と新しいセッションだけを伝える。 */
export function startDiscordGateway(input: {
  token: string;
  getGatewayInfo(): ReturnType<typeof getDiscordGatewayInfo>;
  onMessage(address: ChannelAddress): Promise<void>;
  onReady(): Promise<void>;
  connect?(url: string, options: ClientOptions): GatewaySocket;
}) {
  const connect = input.connect ?? ((url, options) => new WebSocket(url, options));
  const connectionOptions = {
    followRedirects: false,
    handshakeTimeout: 10_000,
    lookup: createGuardedLookup(),
    maxPayload: 8 * 1024 * 1024,
  };
  let lastIdentifyAt = -Infinity;
  let session: Session | undefined;
  let socket: GatewaySocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let reconnectMs = MIN_RECONNECT_MS;
  let stopped = false;

  function retry(waitMs = 0) {
    if (stopped) return;
    const backoff = Math.max(reconnectMs, Math.min(waitMs, MAX_IDENTIFY_WAIT_MS));
    reconnect = setTimeout(open, backoff);
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
  }

  function open() {
    if (stopped) return;
    if (session) {
      openSocket(session.url);
      return;
    }
    const waitForIdentify = lastIdentifyAt + IDENTIFY_INTERVAL_MS - Date.now();
    if (waitForIdentify > 0) {
      reconnect = setTimeout(open, waitForIdentify);
      return;
    }
    // Discord が持つ残数を見る。上限に達すると REST と共用する Bot トークンもリセットされる。
    void input.getGatewayInfo().then(
      (info) => {
        if (stopped) return;
        if (info.remaining <= 1) {
          retry(info.resetAfterMs);
          return;
        }
        openSocket(info.url);
      },
      (error: unknown) => retry(error instanceof FetchFeedError ? (error.retryAfterMs ?? 0) : 0),
    );
  }

  function openSocket(address: string) {
    let connection: GatewaySocket;
    try {
      connection = connect(gatewayUrl(address), connectionOptions);
    } catch {
      session = undefined;
      retry();
      return;
    }
    socket = connection;
    let canResume = false;
    let needsAck = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const startup = setTimeout(() => connection.terminate(), STARTUP_TIMEOUT_MS);
    const send = (op: number, d: unknown) => connection.send(JSON.stringify({ op, d }));
    const beat = () => {
      needsAck = true;
      send(1, session?.sequence ?? null);
    };
    const beginHeartbeat = (interval: number) => {
      const tick = () => {
        if (needsAck) {
          connection.terminate();
          return;
        }
        beat();
        heartbeat = setTimeout(tick, interval);
      };
      heartbeat = setTimeout(tick, Math.floor(Math.random() * interval));
    };

    connection.on("message", (data) => {
      if (stopped || socket !== connection) return;
      const event = readPayload(data);
      if (!event) return;

      switch (event.op) {
        case 10: {
          const settings = hello.safeParse(event.d);
          if (!settings.success || heartbeat !== undefined) return;
          beginHeartbeat(settings.data.heartbeat_interval);
          if (session) {
            send(6, { token: input.token, session_id: session.id, seq: session.sequence });
          } else {
            lastIdentifyAt = Date.now();
            send(2, {
              token: input.token,
              intents: GUILD_MESSAGES,
              properties: { os: process.platform, browser: "sendo", device: "sendo" },
            });
          }
          return;
        }
        case 1:
          beat();
          return;
        case 11:
          needsAck = false;
          return;
        case 7:
          canResume = session !== undefined;
          connection.terminate();
          return;
        case 9:
          canResume = event.d === true;
          connection.terminate();
          return;
        case 0:
          break;
        default:
          return;
      }

      if (event.s == null) return;
      if (session) session.sequence = event.s;
      switch (event.t) {
        case "READY": {
          const info = ready.safeParse(event.d);
          if (!info.success) return;
          session = {
            id: info.data.session_id,
            url: info.data.resume_gateway_url,
            sequence: event.s,
          };
          canResume = true;
          clearTimeout(startup);
          reconnectMs = MIN_RECONNECT_MS;
          void input.onReady().catch(() => console.warn("Could not queue Discord catch-up"));
          return;
        }
        case "RESUMED":
          canResume = true;
          clearTimeout(startup);
          reconnectMs = MIN_RECONNECT_MS;
          return;
        case "MESSAGE_CREATE": {
          const address = message.safeParse(event.d);
          if (!address.success) return;
          const { guild_id: guildId, channel_id: channelId } = address.data;
          void input
            .onMessage({ guildId, channelId })
            .catch(() => console.warn("Could not queue Discord channel fetch"));
          return;
        }
      }
    });

    connection.on("error", () => connection.terminate());
    connection.on("close", (code) => {
      clearTimeout(startup);
      clearTimeout(heartbeat);
      if (socket === connection) socket = undefined;
      if (stopped) return;
      // 再開前に接続が失敗したときは、既定の Gateway で新しいセッションを作る。
      if (!canResume || code === 4007 || code === 4009) session = undefined;
      if (code === 4004 || (code >= 4010 && code <= 4014)) {
        console.warn("Discord Gateway stopped after Discord rejected the connection", { code });
        return;
      }
      retry();
    });
  }

  open();
  return {
    stop() {
      stopped = true;
      clearTimeout(reconnect);
      socket?.terminate();
    },
  };
}
