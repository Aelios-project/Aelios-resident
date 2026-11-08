// One helper session for one conversation of the resident: an ACP process (started by a plug) and its session, kept
// alive while the box runs. Each turn sends only what is new. The cloud keeps the whole conversation, so nothing of it
// is stored here: a session that is gone (the box restarted, it errored, it sat idle, or the resident compacted or
// edited its conversation) is dropped, with its throwaway home, and the next turn starts a new one seeded from the
// resident's current messages (prompt.mjs).
//
// The resident's tools reach the helper through an MCP server the box serves (tools.mjs). A call parks there, the
// reply streams back with the call and ends, the resident runs the tool itself, and its next request carries the
// result, which answers the parked call; the same helper then goes on, and its next reply streams to that request.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpConnection, AcpError, PROTOCOL_VERSION } from "./acp.mjs";
import { callResult, toolsFor } from "./tools.mjs";

// How long a reply that reached a tool call waits for more calls (and for the text before them to arrive).
const GRACE_MS = 300;
// How long a turn that stopped at the resident's calls waits for their results before the session is dropped.
export const WAIT_MS = Number(process.env.BOX_WAIT_MS || 9 * 60_000);
const TURN_MS = Number(process.env.BOX_TURN_MS || 30 * 60_000);
// A session nobody talked to for this long is dropped (its process and files go).
const IDLE_MS = Number(process.env.BOX_IDLE_MS || 60 * 60_000);
const UNANSWERED = { content: [{ type: "text", text: "No result came back for this call." }], isError: true };
const LATE = { content: [{ type: "text", text: "Call this tool again once the other results are in." }], isError: true };

/** The text with the API key taken out, for anything that is sent back. */
export const scrub = (text, key) => (key ? String(text).split(key).join("[key]") : String(text));

// Live sessions by their MCP address, by the id of each call they wait on, and by conversation key.
export const byAddress = new Map();
export const byCall = new Map();
export const byConversation = new Map();

/** What a live helper cannot change after it started: its model, its prompt and its tools. */
export function fingerprintOf(turn) {
  return createHash("sha256").update(JSON.stringify([turn.helper ?? "kiro", turn.model, turn.system, toolsFor(turn.tools)])).digest("hex");
}

export class Session {
  constructor({ plug, turn, key, ctx }) {
    this.id = randomUUID();
    // Any program on this machine can reach the loopback port, so the session's MCP server also wants a key only its helper has.
    this.secret = randomBytes(32).toString("hex");
    Object.assign(this, { plug, key, ctx, model: turn.model, system: turn.system, apiKey: String(turn.key ?? "").trim() });
    this.fingerprint = fingerprintOf(turn);
    this.tools = toolsFor(turn.tools);
    this.reply = null;
    this.asked = [];
    this.parked = new Map();
    this.credits = null;
    this.dropped = false;
    this.collecting = false;
    this.timer = null;
    // What the helper has been told: { count, hash } of the resident's messages up to its last request.
    this.sync = null;
  }

  /** Whether a turn waits on the resident's tool results, or a reply is streaming. */
  get busy() {
    return Boolean(this.reply) || this.asked.length > 0;
  }

  /** Starts the helper and opens its session. Throws what went wrong. */
  async open() {
    byAddress.set(this.id, this);
    // A home for this session alone, thrown away with it.
    this.home = await mkdtemp(join(tmpdir(), "acp-box-"));
    await mkdir(join(this.home, "work"), { mode: 0o700 });
    const tool = this.tools.length ? { url: `${this.ctx.base()}/mcp/${this.id}`, secret: this.secret, timeoutMs: WAIT_MS + 60_000 } : null;
    await this.plug.setup({ home: this.home, key: this.apiKey, system: this.system, tool });
    this.conn = new AcpConnection(this.plug.launch({ home: this.home, key: this.apiKey, model: this.model, tool }), {
      onNotification: (method, params) => this.#update(method, params),
      // Nothing is trusted but the resident's tools, which the helper's own settings allow; the rest is turned down.
      onRequest: async (method) => {
        if (method !== "session/request_permission") throw new AcpError("method not found", -32601);
        return { outcome: { outcome: "cancelled" } };
      }
    }).start();
    try {
      await this.conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "acp-box", version: "1" } }, 30_000);
      const created = await this.conn.request("session/new", { cwd: join(this.home, "work"), mcpServers: [] }, 60_000);
      if (typeof created.sessionId !== "string" || !created.sessionId) throw new AcpError("the helper gave no session id", -32603);
      this.sessionId = created.sessionId;
    } catch (error) {
      throw new Error(scrub(this.conn.stderr.trim().split("\n").pop() || String(error?.message ?? error), this.apiKey).slice(0, 400));
    }
  }

  #update(method, params) {
    if (!this.collecting) return;
    const credits = this.plug.credits(method, params);
    if (credits !== null) this.credits = credits;
    const update = params?.update;
    if (method !== "session/update" || update?.sessionUpdate !== "agent_message_chunk") return;
    if (update.content?.type === "text" && update.content.text) this.reply?.write({ text: update.content.text });
  }

  /** Streams the next reply to this /turn; settles when that reply ended (at calls, or at the end of the turn). */
  #attach(write, signal, sync) {
    clearTimeout(this.timer);
    this.sync = sync;
    return new Promise((resolve) => {
      const reply = { write, resolve, calls: [], timer: null };
      this.reply = reply;
      const cancel = () => this.reply === reply && void this.drop("cancelled");
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  }

  /** Sends the helper new input; settles when its reply ended. */
  prompt(text, write, signal, sync) {
    const replied = this.#attach(write, signal, sync);
    this.collecting = true;
    const stuck = setTimeout(() => void this.drop("the turn took too long"), TURN_MS);
    this.conn
      .request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] })
      .then((result) => {
        const reason = String(result.stopReason ?? "end_turn");
        if (reason !== "end_turn") return this.drop(reason === "cancelled" ? "cancelled" : `the helper stopped (${reason})`);
        this.finish(null);
        // Idle: kept for the next turn of the conversation; a turn on its own ends its session.
        if (!this.key) return this.drop("done");
        this.timer = setTimeout(() => void this.drop("idle"), IDLE_MS);
        this.timer.unref?.();
      })
      .catch((error) => this.drop(`the helper stopped: ${this.conn.stderr.trim().split("\n").pop() || error?.message || "no answer"}`))
      .finally(() => clearTimeout(stuck));
    return replied;
  }

  finish(failure) {
    const reply = this.reply;
    if (!reply) return;
    this.reply = null;
    clearTimeout(reply.timer);
    reply.write(failure ? { error: scrub(failure, this.apiKey).slice(0, 400) } : { done: { credits: this.credits } });
    this.credits = null;
    reply.resolve();
  }

  /** The helper called a tool (an MCP tools/call): its result, once the resident has sent it. */
  call(params) {
    const reply = this.reply;
    if (this.dropped) return Promise.resolve(UNANSWERED);
    if (!reply) return Promise.resolve(LATE);
    const id = `toolu_${randomBytes(12).toString("hex")}`;
    reply.calls.push({ id, name: String(params?.name ?? ""), input: params?.arguments ?? {} });
    reply.timer ??= setTimeout(() => this.#stopAt(reply), GRACE_MS);
    return new Promise((resolve) => this.parked.set(id, resolve));
  }

  /** The reply reached its calls: it ends with them, and the turn waits for the resident's results. */
  #stopAt(reply) {
    if (this.reply !== reply || this.dropped) return;
    this.asked = reply.calls;
    for (const use of this.asked) {
      byCall.set(use.id, this);
      reply.write({ tool: use });
    }
    this.timer = setTimeout(() => void this.drop("the resident's results did not come back"), WAIT_MS);
    this.credits = null;
    this.finish(null);
  }

  /** Whether these results answer the calls this turn waits on, and nothing else. */
  answers(results) {
    return !this.dropped && this.asked.length > 0 && results.every((block) => this.asked.some((use) => use.id === block?.tool_use_id));
  }

  /** The resident's results: the parked calls get them, and the next reply streams to this /turn. */
  go(results, write, signal, sync) {
    const asked = this.asked;
    this.asked = [];
    for (const use of asked) byCall.delete(use.id);
    const replied = this.#attach(write, signal, sync);
    for (const use of asked) {
      const block = results.find((item) => item.tool_use_id === use.id);
      const answer = this.parked.get(use.id);
      this.parked.delete(use.id);
      answer?.(block ? callResult(block) : UNANSWERED);
    }
    return replied;
  }

  /** Ends the session: the process stops, its files go, and a reply still streaming ends with the reason. */
  async drop(reason) {
    if (this.dropped) return;
    this.dropped = true;
    clearTimeout(this.timer);
    for (const use of this.asked) if (byCall.get(use.id) === this) byCall.delete(use.id);
    for (const resolve of this.parked.values()) resolve(UNANSWERED);
    this.parked.clear();
    byAddress.delete(this.id);
    if (this.key && byConversation.get(this.key) === this) byConversation.delete(this.key);
    if (!["done", "idle"].includes(reason)) this.finish(reason);
    await this.conn?.close(0);
    if (this.home) await rm(this.home, { recursive: true, force: true }).catch(() => {});
  }
}
