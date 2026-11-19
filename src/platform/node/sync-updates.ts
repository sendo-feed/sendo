import { type HttpBindings, upgradeWebSocket, type WebSocketServerLike } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import type { Database } from "../../db";
import { activeSessionIds, type SessionIdentity } from "../../db/sessions";
import type { SyncUpdates } from "..";

const SYNC_REQUIRED = JSON.stringify({ type: "sync_required" });
const MAX_CONNECTIONS = 512;
const MAX_CONNECTIONS_PER_USER = 8;
const HEARTBEAT_INTERVAL_MS = 30_000;

type Connection = [WebSocket, SessionIdentity];

/** HTTP と取得ジョブが同じプロセスで動くので、接続はメモリに持つ。 */
export function createNodeSyncUpdates(
  db: Database,
  options: { heartbeatIntervalMs?: number; invalidPublicOrigin?: boolean } = {},
) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const byUser = new Map<string, Map<WebSocket, SessionIdentity>>();
  let stopping = false;

  async function activeConnections(connections: Connection[]): Promise<Connection[]> {
    if (connections.length === 0) return [];
    const identities = new Map(connections.map(([, session]) => [session.id, session]));
    const active = await activeSessionIds(db, [...identities.values()], new Date());
    return connections.filter(([socket, session]) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      if (active.has(session.id)) return true;
      socket.close(1008, "session ended");
      return false;
    });
  }

  // 切断が TCP から伝わらないときも、応答しない接続の枠を空ける。
  const waitingForPong = new WeakSet<WebSocket>();
  let checkingSessions = false;
  const heartbeat = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (waitingForPong.has(socket)) {
        socket.terminate();
      } else {
        waitingForPong.add(socket);
        socket.ping();
      }
    }
    if (checkingSessions || byUser.size === 0) return;
    checkingSessions = true;
    const connections = [...byUser.values()].flatMap((sockets) => [...sockets]);
    void activeConnections(connections)
      .catch(() => console.warn("could not check notification sessions"))
      .finally(() => {
        checkingSessions = false;
      });
  }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS).unref();

  const updates: SyncUpdates = {
    async connect(context, session) {
      // 通常の HTTP には outgoing があり、Upgrade のときは incoming だけが渡る。
      const bindings: Partial<HttpBindings> | undefined = context.env;
      if (!bindings?.incoming || bindings.outgoing !== undefined) {
        return new Response(null, { status: 400 });
      }
      if (options.invalidPublicOrigin) return new Response(null, { status: 403 });
      if (stopping) return new Response(null, { status: 503 });
      const userId = session.userId;
      if (
        webSocketServer.clients.size >= MAX_CONNECTIONS ||
        (byUser.get(userId)?.size ?? 0) >= MAX_CONNECTIONS_PER_USER
      ) {
        return new Response(null, { status: 429 });
      }

      return upgradeWebSocket(context, {
        onOpen(_event, ws) {
          const socket = ws.raw;
          if (!(socket instanceof WebSocket)) return;
          // 再開する時点で、認証中に通った別の接続も数え直す。
          let connections = byUser.get(userId);
          if (
            stopping ||
            webSocketServer.clients.size > MAX_CONNECTIONS ||
            (connections?.size ?? 0) >= MAX_CONNECTIONS_PER_USER
          ) {
            socket.close(1013, "try again later");
            return;
          }
          if (connections === undefined) {
            connections = new Map();
            byUser.set(userId, connections);
          }
          connections.set(socket, session);
          const remove = () => {
            const current = byUser.get(userId);
            if (current?.delete(socket) && current.size === 0) byUser.delete(userId);
          };
          socket.on("close", remove);
          socket.on("error", remove);
          socket.on("pong", () => waitingForPong.delete(socket));
        },
        onMessage(_event, socket) {
          socket.close(1008, "client messages are not supported");
        },
      });
    },

    async notify(userIds) {
      const connections = userIds.flatMap((userId) => [...(byUser.get(userId) ?? [])]);
      for (const [socket] of await activeConnections(connections)) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        try {
          if (socket.bufferedAmount > 64 * 1024) socket.terminate();
          else socket.send(SYNC_REQUIRED);
        } catch {
          // 接続が途中で切れても、残りの端末への通知は続ける。
        }
      }
    },
  };

  return {
    updates,
    // ws の send オーバーロードと Hono の省略可能な options は、実行時は同じ呼び方を受ける。
    webSocketServer: webSocketServer as unknown as WebSocketServerLike,
    stop() {
      stopping = true;
      clearInterval(heartbeat);
      for (const socket of webSocketServer.clients) socket.terminate();
    },
  };
}
