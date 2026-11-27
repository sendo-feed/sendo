import { EventEmitter } from "node:events";
import type { ClientOptions } from "ws";

class FakeSocket extends EventEmitter {
  sent: unknown[] = [];
  closed = false;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", 1006);
  }

  receive(op: number, d: unknown, dispatch?: { s: number; t: string }) {
    this.emit("message", Buffer.from(JSON.stringify({ op, d, ...dispatch })));
  }

  hello(interval = 90_000) {
    this.receive(10, { heartbeat_interval: interval });
  }

  ready(s = 1, url = "wss://gateway-us-east1-b.discord.gg/") {
    this.receive(0, { session_id: "session", resume_gateway_url: url }, { s, t: "READY" });
  }
}

export function fakeDiscordGateway() {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const options: ClientOptions[] = [];
  return {
    urls,
    options,
    connect(url: string, settings: ClientOptions) {
      urls.push(url);
      options.push(settings);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    socket(index = 0) {
      const socket = sockets[index];
      if (!socket) throw new Error(`Gateway connection ${index} was not opened`);
      return socket;
    },
  };
}
