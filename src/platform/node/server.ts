import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";

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

  // Hono は WebSocket 以外の Upgrade を処理しない。Hono が拒否応答も返せるよう、
  // upgrade のリスナーは 1 つのままにし、WebSocket 以外のソケットはここで閉じる。
  server.off("upgrade", upgrade);
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.upgrade?.toLowerCase() === "websocket") {
      upgrade.call(server, request, socket, head);
    } else {
      socket.destroy();
    }
  });
  return server;
}
