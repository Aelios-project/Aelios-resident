// The Kiro box: the resident's turns through Kiro CLI in headless mode, signed in with the owner's own Kiro API key
// (KIRO_API_KEY, ksk_…), which uses the owner's Kiro credits. It runs on a machine of the owner's, behind a
// Cloudflare Tunnel, like the Claude box (docs/claude-box.md). It keeps nothing: the resident sends the whole
// conversation every turn.
//
//   GET  /health   200 once the server listens
//   POST /turn     { key, model, system, prompt } → NDJSON, one object a line:
//                    { "text": "…" } …            a piece of the reply
//                    { "done": { "credits": n } }  the turn finished; n is what Kiro reports (null if nothing)
//                    { "error": "…" }              instead of done when the turn failed
//                  With BOX_KEY set, a turn needs `authorization: Bearer <BOX_KEY>`.
//
// Kiro is stripped down for every turn (agent.mjs): a custom agent with the resident's prompt, no tools, no MCP
// servers, no steering files, `--trust-tools=` so nothing is trusted, in a home folder and a working folder that
// are empty and thrown away afterwards.

import http from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentConfig, AGENT_NAME, kiroArgs, kiroEnv, MODEL_PATTERN, PROMPT_MAX_CHARS, readEvent, scrub } from "./agent.mjs";

const MAX_BODY = 4 * 1024 * 1024;
const TURN_MS = Number(process.env.BOX_TURN_MS || 10 * 60_000);
// Overridable so tests can run a fake process; a real box leaves it alone.
const BIN = () => process.env.KIRO_BIN || "kiro-cli";

function authorized(request, key) {
  if (!key) return true;
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
  if (typeof turn.key !== "string" || !turn.key.trim()) return "KIRO_API_KEY is not set: put your Kiro API key (ksk_…) on the settings page";
  if (typeof turn.model !== "string" || !MODEL_PATTERN.test(turn.model)) return "model is missing or not a valid Kiro model id";
  if (typeof turn.prompt !== "string" || !turn.prompt.trim()) return "prompt is empty";
  return null;
}

/** Runs one turn: writes the objects of the NDJSON answer through `write`; stops the process when `signal` aborts. */
export async function runTurn(turn, write, signal) {
  const key = turn.key.trim();
  // A home and a working folder for this turn alone: no .kiro in the working folder, no global mcp.json or steering.
  const home = await mkdtemp(join(tmpdir(), "kiro-box-"));
  try {
    await mkdir(join(home, ".kiro", "agents"), { recursive: true });
    await writeFile(join(home, ".kiro", "agents", `${AGENT_NAME}.json`), JSON.stringify(agentConfig(turn.system)), { mode: 0o600 });
    const cwd = join(home, "work");
    await mkdir(cwd);
    const prompt = turn.prompt.length > PROMPT_MAX_CHARS ? turn.prompt.slice(-PROMPT_MAX_CHARS) : turn.prompt;
    const child = spawn(BIN(), kiroArgs(turn.model, prompt), { cwd, env: kiroEnv(key, home), stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, TURN_MS);
    let credits = null;
    let said = false;
    let stderr = "";
    let buffer = "";
    const take = (line) => {
      const event = readEvent(line);
      if (event.text) {
        said = true;
        write({ text: event.text });
      }
      if (event.credits !== undefined) credits = event.credits;
    };
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        take(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    child.stdout.setEncoding("utf8");
    const code = await new Promise((resolve) => {
      child.on("error", (error) => {
        stderr = String(error.message);
        resolve(-1);
      });
      child.on("close", resolve);
    });
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (buffer.trim()) take(buffer);
    if (signal?.aborted) return;
    if (code !== 0) write({ error: scrub(stderr.trim().split("\n").pop() || `kiro-cli stopped with code ${code}`, key).slice(0, 400) });
    else if (!said) write({ error: "Kiro sent no reply" });
    else write({ done: { credits } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export function createBox({ boxKey = process.env.BOX_KEY || "" } = {}) {
  return http.createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://box").pathname;
    if (request.method === "GET" && path === "/health") return void response.writeHead(200).end("ok");
    if (request.method !== "POST" || path !== "/turn") return void response.writeHead(404).end();
    if (!authorized(request, boxKey)) return void response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "wrong box key" }));
    let turn;
    try {
      turn = await readJson(request);
    } catch {
      return void response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad request" }));
    }
    const why = problem(turn);
    if (why) return void response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: why }));
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    try {
      await runTurn(turn, (object) => response.write(`${JSON.stringify(object)}\n`), abort.signal);
    } catch (error) {
      response.write(`${JSON.stringify({ error: scrub(error instanceof Error ? error.message : String(error), turn.key) })}\n`);
    }
    response.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // On a machine of its own the box listens only where the tunnel reaches it (BOX_HOST=127.0.0.1).
  createBox().listen(Number(process.env.PORT || 8791), process.env.BOX_HOST || undefined, () => console.log("kiro box listening"));
}
