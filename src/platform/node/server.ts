import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";

const SYNC_UPDATES_PATH = "/api/v1/sync/updates";
const UPGRADE_TIMEOUT_MS = 5_000;

/** HTTP と WebSocket の入口を組み立てる。 */
export function createNodeServer(
  fetch: Parameters<typeof createAdaptorServer>[0]["fetch"],
  webSocketServer: WebSocketServerLike,
  hostname: string,
): Server {
  const server = createAdaptorServer({
    createServer,
    fetch,
    hostname,
    websocket: { server: webSocketServer },
  }) as Server;
  const [upgrade] = server.listeners("upgrade") as Array<
    (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  >;
  if (!upgrade) throw new Error("missing Hono WebSocket upgrade listener");

  const pending = new WeakMap<IncomingMessage, NodeJS.Timeout>();
  const clearDeadline = (request: IncomingMessage) => {
    clearTimeout(pending.get(request));
    pending.delete(request);
  };
  webSocketServer.on("connection", (_socket, request) => clearDeadline(request));

  // Hono の拒否応答を保つため、upgrade のリスナーは 1 つにする。
  server.off("upgrade", upgrade);
  server.on("upgrade", (request, socket, head) => {
    if (
      request.method !== "GET" ||
      request.url?.split("?", 1)[0] !== SYNC_UPDATES_PATH ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      socket.destroy();
      return;
    }

    // 接続が成立するか閉じるまで期限を置き、ハンドシェイク途中のソケットを回収する。
    pending.set(request, setTimeout(() => socket.destroy(), UPGRADE_TIMEOUT_MS).unref());
    socket.once("close", () => clearDeadline(request));
    upgrade.call(server, request, socket, head);
  });
  return server;
}
