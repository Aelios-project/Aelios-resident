// Kiro on the owner's own credits: `kiro/<model>` (kiro/auto and so on). The turn goes to the Kiro box
// (kiro-box/server.mjs, docs in README), Kiro CLI in headless mode signed in with the owner's `KIRO_API_KEY`, on a
// small machine of the owner's behind a Cloudflare Tunnel. Think keeps the conversation, the persona, the letters and
// the heartbeat; only the call to the model goes to the box.
//
// The resident is a personal secretary agent: it reads messages, decides, and hands work to threads. Inside the box
// no tool is trusted (no shell, no file writes, no MCP servers), so a Kiro turn only talks. Each turn carries the
// whole conversation as text; the box keeps nothing.
// shortcut: the resident's own tools are not offered to Kiro, and pictures go as "[picture]"; add them when Kiro's
// headless mode can take tool definitions from the caller.
//
// To the AI SDK this is an Anthropic model whose requests never leave the Worker but for the box: the box's NDJSON
// is handed back as the Messages API's own stream events.

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { blocksOf, lines, messageOf, refusal, saidIn, sse, systemText, type Block, type Message, type StreamEvent } from "./claude-code";
import { isNote } from "./prompts";

export const KIRO_PREFIX = "kiro/";
export const NO_KIRO_KEY = "KIRO_API_KEY is not set: create a Kiro API key (ksk_…) and put it on the settings page, Providers";
export const NO_KIRO_BOX = "The Kiro box address is not set: install the box (README, Kiro box) and put its address and key on the settings page, Providers";
const PROMPT_MAX = 100_000;

export function isKiro(id: string): boolean {
  return id.startsWith(KIRO_PREFIX);
}

/** A turn's way to the box and back, and what the resident does around it. */
export type KiroTurn = {
  /** The owner's Kiro API key. */
  key: string;
  /** Sends a turn to the box (POST /turn) and answers with its NDJSON stream. */
  send(body: string, signal?: AbortSignal): Promise<Response>;
  /** What long-term memory brings up for what was said ("" for nothing). */
  recall?(said: string): Promise<string>;
  /** For their own turns, after the reply: what was said and what was answered. */
  record?(said: string, reply: string): void;
  /** What Kiro reported for the turn, in credits. */
  credits?(credits: number): void;
};

/** One message as text: Kiro gets the conversation as a transcript, pictures and tool traces as short markers. */
function textOf(message: Message): string {
  return blocksOf(message.content)
    .map((block: Block) => (block.type === "text" ? String(block.text ?? "") : block.type === "image" ? "[picture]" : block.type === "document" ? "[document]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** The whole conversation as one prompt; the newest part is kept when it is too long. */
export function transcriptOf(messages: Message[], memory = ""): string {
  const turns = messages.map((message) => ({ who: message.role === "assistant" ? "You" : "User", text: textOf(message) })).filter((turn) => turn.text);
  const body = turns.map((turn) => `${turn.who}: ${turn.text}`).join("\n\n");
  const note = memory ? `\n\n${memory}` : "";
  const head = "The conversation so far is below. Reply as You, to the User's last message, and write only the reply.\n\n";
  return `${head}${body.length > PROMPT_MAX ? body.slice(-PROMPT_MAX) : body}${note}`;
}

/** Why the box turned a turn down, with the key taken out of whatever it said. */
export function kiroError(message: string, key: string): string {
  const text = (key ? message.split(key).join("[key]") : message).trim() || "Kiro did not reply this turn";
  if (/unauthor|invalid.*(key|token)|not logged in|401|403/i.test(text)) return `Kiro did not accept the API key: make a new one and put it on the settings page (${text})`;
  if (/credit|limit|quota|429/i.test(text)) return `Kiro credits or limit reached: ${text}`;
  return `Kiro turn failed: ${text}`;
}

/** The fetch the Anthropic provider uses: every request becomes a turn in the Kiro box. */
export function kiroFetch(turn: KiroTurn): typeof fetch {
  return async (_input, init) => {
    if (typeof init?.body !== "string") return refusal(400, "Kiro takes conversation only");
    if (!turn.key) return refusal(401, NO_KIRO_KEY);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
    const last = messages.at(-1);
    if (!last || last.role !== "user") return refusal(400, "Nothing new to reply to");
    const said = saidIn(last.content);
    const hers = Boolean(said) && !isNote(said.trimStart());
    const memory = hers && turn.recall ? await turn.recall(said).catch(() => "") : "";
    const request = JSON.stringify({ key: turn.key, model: String(body.model ?? ""), system: systemText(body.system), prompt: transcriptOf(messages, memory) });
    const abandon = () => {
      throw init.signal?.reason ?? new DOMException("The call was aborted", "AbortError");
    };
    let response: Response;
    try {
      response = await turn.send(request, init.signal ?? undefined);
    } catch (error) {
      if (init.signal?.aborted) abandon();
      return refusal(503, `Kiro box not reachable: ${kiroError(error instanceof Error ? error.message : String(error), turn.key)}`);
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let reason = text;
      try {
        reason = String((JSON.parse(text) as { error?: unknown }).error ?? text);
      } catch {
        // Not JSON: the text as it is.
      }
      if (response.status === 501) return refusal(400, reason || NO_KIRO_BOX);
      if (response.status === 401) return refusal(400, "The Kiro box did not accept its key: the box key on the settings page must be the one the box was started with");
      return refusal(response.status >= 500 ? 503 : 400, `Kiro box refused the turn (${response.status}): ${kiroError(reason, turn.key).slice(0, 300)}`);
    }
    const stop = new AbortController();
    init.signal?.addEventListener("abort", () => stop.abort(init.signal?.reason), { once: true });
    const stream = lines(response.body, stop.signal);
    const events: StreamEvent[] = [];
    let opened = false;
    let finished = false;
    let index = -1;
    /** The stream events one box line makes. */
    const take = (line: Record<string, unknown>): { events: StreamEvent[]; error?: string } => {
      const out: StreamEvent[] = [];
      if (typeof line.text === "string" && line.text) {
        if (!opened) {
          opened = true;
          out.push({ type: "message_start", message: { id: `kiro_${crypto.randomUUID()}`, type: "message", role: "assistant", model: String(body.model ?? ""), content: [], usage: { input_tokens: 0, output_tokens: 0 } } });
          out.push({ type: "content_block_start", index: (index = 0), content_block: { type: "text", text: "" } });
        }
        out.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: line.text } });
      }
      if (typeof line.error === "string") return { events: out, error: kiroError(line.error, turn.key) };
      const done = line.done as { credits?: unknown } | undefined;
      if (done) {
        finished = true;
        if (typeof done.credits === "number" && Number.isFinite(done.credits)) turn.credits?.(done.credits);
        if (opened) {
          out.push({ type: "content_block_stop", index });
          out.push({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } });
          out.push({ type: "message_stop" });
        }
      }
      events.push(...out);
      return { events: out };
    };
    const finish = (): void => {
      const reply = saidIn(messageOf(events).content);
      if (hers && turn.record && reply) turn.record(said, reply);
    };
    try {
      if (body.stream !== true) {
        for (let line = await stream.next(); !line.done; line = await stream.next()) {
          const { error } = take(line.value);
          if (error) return refusal(400, error);
          if (finished) break;
        }
        if (init.signal?.aborted) abandon();
        if (!finished || !opened) return refusal(503, "Kiro box ended without a reply");
        finish();
        return Response.json(messageOf(events));
      }
      // The first line decides: a turn the box turned down before saying anything is a refused call.
      const first = await stream.next();
      if (first.done) return refusal(503, "Kiro box sent nothing");
      const opening = take(first.value);
      if (opening.error) return refusal(400, opening.error);
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (items: StreamEvent[]) => items.forEach((event) => controller.enqueue(sse(event)));
            send(opening.events);
            try {
              for (let line = finished ? { done: true as const, value: undefined } : await stream.next(); !line.done; line = await stream.next()) {
                const next = take(line.value);
                send(next.events);
                if (next.error) {
                  controller.enqueue(sse({ type: "error", error: { type: "api_error", message: next.error } }));
                  break;
                }
                if (finished) break;
              }
              if (!finished && !stop.signal.aborted) controller.enqueue(sse({ type: "error", error: { type: "api_error", message: "Kiro box ended before the reply was complete" } }));
              else finish();
            } catch (error) {
              if (!stop.signal.aborted) controller.enqueue(sse({ type: "error", error: { type: "api_error", message: kiroError(String(error), turn.key) } }));
            }
            await stream.return(undefined);
            try {
              controller.close();
            } catch {
              // Already cancelled by the reader.
            }
          },
          cancel(reason) {
            stop.abort(reason);
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    } catch (error) {
      if (init.signal?.aborted) abandon();
      return refusal(503, `Kiro box connection broke: ${kiroError(String(error), turn.key)}`);
    } finally {
      if (body.stream !== true) await stream.return(undefined);
    }
  };
}

/** `kiro/<model>` as a model whose every call is a turn in the box. */
export function kiroModel(id: string, turn: KiroTurn): LanguageModel {
  // The address is never reached: every request is answered by kiroFetch.
  return createAnthropic({ baseURL: "https://kiro-box.invalid/v1", apiKey: "kiro", fetch: kiroFetch(turn) })(id.slice(KIRO_PREFIX.length));
}
