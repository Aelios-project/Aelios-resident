// The ACP box: the resident's turns through a helper that speaks ACP (Agent Client Protocol), signed in with the
// owner's own account. Today the plug is Kiro (plugs/kiro.mjs, `kiro-cli acp` on the owner's Kiro credits). It runs
// on a machine of the owner's behind a Cloudflare Tunnel, like the Claude box (docs/claude-box.md).
//
//   GET  /health   200 once the server listens
//   POST /turn     { helper?, key, model, system, tools?, conversation?, messages, note?, results? } → NDJSON, a line each:
//                    { "text": "…" } …                    a piece of the reply
//                    { "tool": { id, name, input } } …    a call of the resident's tools the reply stops at
//                    { "done": { "credits": n } }          the reply ended (n: what the helper reports, or null)
//                    { "error": "…" }                      instead of done when the turn failed
//                  With BOX_KEY set, a turn needs `authorization: Bearer <BOX_KEY>`.
//
// messages is the conversation as [{ who: "User" | "You", text, mark }], mark a hash of the conversation up to that
// message. With a conversation id, the box keeps one live helper session for it while it runs and sends only what is
// new (session.mjs, prompt.mjs); without one, the turn is on its own. Nothing is written down: the cloud keeps the
// conversation, and a session that is gone is seeded again from it. tools are the resident's (Messages API
// definitions); results are the tool_result blocks that answer the calls the reply before stopped at.

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { messagesProblem, plan } from "./prompt.mjs";
import kiro from "./plugs/kiro.mjs";
import { byAddress, byCall, byConversation, fingerprintOf, scrub, Session } from "./session.mjs";
import { mcp } from "./tools.mjs";

const MAX_BODY = 64 * 1024 * 1024;
// A helper is a plug here; a later one (another ACP agent) is added to this list.
const PLUGS = new Map([kiro].map((plug) => [plug.name, plug]));

function carries(request, key) {
  const given = Buffer.from(String(request.headers.authorization ?? ""));
  const wanted = Buffer.from(`Bearer ${key}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Checks a turn's body; the reason it cannot run, or null. */
export function problem(turn) {
  if (!turn || typeof turn !== "object") return "turn must be a JSON object";
  const plug = PLUGS.get(turn.helper ?? "kiro");
  if (!plug) return "unknown helper";
  if (typeof turn.system !== "string") return "no system prompt";
  if (turn.conversation !== undefined && (typeof turn.conversation !== "string" || !turn.conversation)) return "conversation must be a non-empty string";
  return messagesProblem(turn.messages, turn.conversation !== undefined) ?? plug.problem(turn);
}

/** A turn: the results a running turn waits on, or a new turn. Settles when its reply has ended. */
export async function takeTurn(turn, write, signal, ctx) {
  const results = Array.isArray(turn.results) ? turn.results : [];
  const sync = { count: turn.messages.length, hash: turn.messages.at(-1).mark };
  const waiter = byCall.get(results[0]?.tool_use_id);
  if (waiter?.answers(results)) return waiter.go(results, write, signal, sync);
  // A turn that waits on some of these calls but is not answered by this request waits for nothing now.
  for (const block of results) await byCall.get(block?.tool_use_id)?.drop("its calls were answered another way");
  const plug = PLUGS.get(turn.helper ?? "kiro");
  const key = turn.conversation ? `${plug.name}:${turn.conversation}` : null;
  const live = key ? byConversation.get(key) : null;
  // The live session carries on only if nothing it cannot change differs, and the conversation is what it was told.
  const next = live && !live.busy && live.fingerprint === fingerprintOf(turn) ? plan(turn.messages, live.sync, turn.note) : null;
  if (next?.resume) return live.prompt(next.input, write, signal, sync);
  // Compacted or edited by the resident, or a different helper setup: that session goes, a new one is seeded.
  await live?.drop("replaced");
  const session = new Session({ plug, turn, key, ctx });
  try {
    await session.open();
  } catch (error) {
    await session.drop("failed");
    write({ error: scrub(error instanceof Error ? error.message : String(error), session.apiKey).slice(0, 400) });
    return;
  }
  if (key) byConversation.set(key, session);
  return session.prompt(plan(turn.messages, null, turn.note).seed, write, signal, sync);
}

export function createBox({ boxKey = process.env.BOX_KEY || "" } = {}) {

  // The box's own address, as the helper reaches the MCP server of a run.
  const ctx = { base: () => `http://127.0.0.1:${server.address().port}` };
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://box").pathname;
    const address = path.match(/^\/mcp\/([0-9a-f-]{36})$/);
    if (address) {
      // Only the run's own helper calls it, with the key it was given.
      const run = byAddress.get(address[1]);
      if (!run || !carries(request, run.secret)) return void response.writeHead(404).end();
      if (request.method !== "POST") return void response.writeHead(405).end();
      let message;
      try {
        message = await readJson(request);
      } catch {
        return void response.writeHead(400).end();
      }
      const answer = await mcp(run, message);
      if (!answer) return void response.writeHead(202).end();
      return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    }
    if (request.method === "GET" && path === "/health") return void response.writeHead(200).end("ok");
    if (request.method !== "POST" || path !== "/turn") return void response.writeHead(404).end();
    if (boxKey && !carries(request, boxKey)) return void response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "wrong box key" }));
    let turn;
    try {
      turn = await readJson(request);
    } catch {
      return void response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad request" }));
    }
    const why = problem(turn);
    if (why) return void response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: why }));
    const gone = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) gone.abort();
    });
    response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const write = (line) => {
      if (!response.destroyed) response.write(`${JSON.stringify(line)}\n`);
    };
    try {
      await takeTurn(turn, write, gone.signal, ctx);
    } catch (error) {
      write({ error: scrub(error instanceof Error ? error.message : String(error), String(turn.key ?? "").trim()) });
    }
    response.end();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // On a machine of its own the box listens only where the tunnel reaches it (BOX_HOST=127.0.0.1).
  const box = createBox();
  box.listen(Number(process.env.PORT || 8791), process.env.BOX_HOST || undefined, () => console.log("acp box listening"));
  // Stopping: every live session goes, with its home (the resident seeds new ones from the conversation).
  const quit = async () => {
    box.close();
    await Promise.all([...byAddress.values()].map((session) => session.drop("the box stopped")));
    process.exit(0);
  };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
}
