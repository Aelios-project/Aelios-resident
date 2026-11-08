// The box hub: one Durable Object per resident that holds the sockets boxes dial in on (acp-box/, protocol in
// box-protocol.ts). It uses the WebSocket Hibernation API, so an idle connection costs nothing: the runtime answers
// the box's "ping" itself and wakes this object only for a real frame. Pairing, the list on the settings page and
// revoking go through here too (box-registry.ts); turns in flight are box-turns.ts.
//
// This is the old ClaudeBox class (the Claude box once ran in a container started from here), renamed by migration
// v3, so no new Durable Object class is made.
import { DurableObject } from "cloudflare:workers";
import { BOX_PROTOCOL, CLOSE_PROTOCOL, CLOSE_REVOKED, parseBoxFrame } from "./box-protocol";
import { BoxRegistry, boxReply } from "./box-registry";
import { BoxTurns } from "./box-turns";
import type { Sql } from "./sticker-store";

/** A box not heard from (not even its ping) for this long is not online. It pings every 25 seconds. */
const STALE_MS = 90_000;
type Link = { boxId: string; conn: string; ready: boolean; at: number };

export class BoxHub extends DurableObject<Env> {
  readonly #registry: BoxRegistry;
  readonly #turns = new BoxTurns();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: Sql = (strings, ...values) => [...ctx.storage.sql.exec(strings.join("?"), ...values)] as never;
    this.#registry = new BoxRegistry(sql, (fn) => ctx.storage.transactionSync(fn));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  #link(ws: WebSocket): Link | null {
    return (ws.deserializeAttachment() as Link | null) ?? null;
  }

  /** The sockets of boxes that said hello and are not stale, by box. */
  #live(): Map<string, { ws: WebSocket; link: Link; seen: number }> {
    const live = new Map<string, { ws: WebSocket; link: Link; seen: number }>();
    for (const ws of this.ctx.getWebSockets()) {
      const link = this.#link(ws);
      if (!link?.ready) continue;
      const seen = Math.max(link.at, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
      if (Date.now() - seen < STALE_MS) live.set(link.boxId, { ws, link, seen });
    }
    return live;
  }

  /** The box's WebSocket: `Authorization: Bearer <box token>`. A token that is not valid gets the socket and an
   *  immediate close with CLOSE_REVOKED, which a box reads as "stop for good". */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    const box = await this.#registry.authenticate(request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "");
    if (!box) {
      server.accept();
      server.close(CLOSE_REVOKED, "revoked");
      return new Response(null, { status: 101, webSocket: client });
    }
    // One connection per box: a new one replaces the old.
    for (const ws of this.ctx.getWebSockets()) if (this.#link(ws)?.boxId === box.id) ws.close(4000, "replaced");
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ boxId: box.id, conn: crypto.randomUUID(), ready: false, at: Date.now() } satisfies Link);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const link = this.#link(ws);
    const frame = link ? parseBoxFrame(message) : null;
    const owner = link && `${link.boxId}.${link.conn}`;
    if (!link || !frame || (!link.ready && frame.t !== "hello") || (link.ready && frame.t === "hello")) {
      if (owner) this.#turns.lost(owner, "the box broke the protocol");
      return ws.close(CLOSE_PROTOCOL, "protocol");
    }
    if (frame.t === "hello") {
      this.#registry.hello(link.boxId, frame.name, frame.plugs, frame.down);
      ws.serializeAttachment({ ...link, ready: true, at: Date.now() } satisfies Link);
    } else if (frame.t === "line") this.#turns.line(owner!, frame.id, frame.line, ws);
    else this.#turns.end(owner!, frame.id);
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    this.#gone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.#gone(ws);
  }

  #gone(ws: WebSocket): void {
    const link = this.#link(ws);
    if (!link) return;
    this.#turns.lost(`${link.boxId}.${link.conn}`, "the box disconnected");
    if (link.ready) this.#registry.seen(link.boxId);
  }

  // The calls below are the Worker's and the resident's (RPC). Replies are { status, body } like machine.ts's.

  code() {
    return boxReply(() => this.#registry.code());
  }

  pair(body: unknown) {
    return boxReply(() => this.#registry.pair(body));
  }

  /** The settings page's list, and which box serves each plug now. */
  async list() {
    const live = this.#live();
    const online = new Set(live.keys());
    return {
      boxes: this.#registry.list(online).map((box) => ({ ...box, lastSeenAt: live.get(box.id)?.seen ?? box.lastSeenAt })),
      protocol: BOX_PROTOCOL
    };
  }

  revoke(id: string) {
    return boxReply(() => {
      this.#registry.revoke(String(id));
      // The socket closes at once, and its turns end.
      for (const ws of this.ctx.getWebSockets()) {
        const link = this.#link(ws);
        if (link?.boxId !== id) continue;
        this.#turns.lost(`${link.boxId}.${link.conn}`, "the box was revoked");
        ws.close(CLOSE_REVOKED, "revoked");
      }
      return { ok: true };
    });
  }

  serve(plug: string, id: string) {
    return boxReply(() => {
      this.#registry.serve(String(plug), String(id ?? ""));
      return { ok: true };
    });
  }

  /** The box that serves a plug right now, or null when none is online. */
  online(plug: string): { id: string; name: string } | null {
    return this.#registry.pick(plug, new Set(this.#live().keys()));
  }

  /** The plugs some online box offers. */
  plugs(): string[] {
    const online = new Set(this.#live().keys());
    return [...new Set(this.#registry.list(online).filter((box) => box.online).flatMap((box) => box.plugs))];
  }

  /**
   * A turn for a plug: the box's NDJSON reply as a streamed Response. Stopping the reader stops the turn on the box.
   * No box online is a 503, and a body that carries a credential is refused: keys stay on the box machine.
   */
  turn(plug: string, body: string): Response {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return Response.json({ error: "bad turn" }, { status: 400 });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || ["key", "token", "apiKey"].some((name) => name in parsed)) {
      return Response.json({ error: "a turn never carries a credential" }, { status: 400 });
    }
    const box = this.#registry.pick(plug, new Set(this.#live().keys()));
    const live = box && this.#live().get(box.id);
    if (!box || !live) return Response.json({ error: `no box is online for ${plug}`, code: "BOX_OFFLINE" }, { status: 503 });
    return this.#turns.start(`${live.link.boxId}.${live.link.conn}`, { send: (data) => live.ws.send(data) }, plug, parsed);
  }
}
