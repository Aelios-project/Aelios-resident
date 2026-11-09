// Kiro on the owner's own credits: `kiro/<model>` (kiro/auto and so on). The turn goes to the ACP box
// (acp-box/ with its Kiro plug, docs in README), which runs `kiro-cli acp` signed in with the owner's
// `KIRO_API_KEY` on a machine of the owner's that dials out to the resident; the key stays there. Think keeps the conversation, the
// persona, the letters and the heartbeat; only the call to the model goes to the box.
//
// The box keeps one live Kiro session per conversation while it runs and sends it only what is new; the resident
// sends the whole conversation every time (as text with marks, kiro-messages.ts), so a box that restarted, or a
// conversation the resident compacted, starts a new session from it.
//
// The resident's tools go along. Kiro calls one through the box's MCP server, the reply stops there as any model's
// does, Think runs it, and the next call brings the result, which the same Kiro session goes on from.
// shortcut: pictures go as "[picture]"; send them when the box passes images to the helper.
//
// To the AI SDK this is an Anthropic model whose requests never leave the Worker but for the box: the box's NDJSON
// is handed back as the Messages API's own stream events.

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { lines, messageOf, ownTools, refusal, saidIn, sse, systemText, type Message, type StreamEvent } from "./claude-code";
import { boxMessages, resultsIn, turnOf } from "./kiro-messages";

export const KIRO_PREFIX = "kiro/";
export const NO_KIRO_BOX = "No box is connected for Kiro: install the box (README, Kiro box) and pair it on the settings page";

export function isKiro(id: string): boolean {
  return id.startsWith(KIRO_PREFIX);
}

/** A turn's way to the box and back, and what the resident does around it. */
export type KiroTurn = {
  /** The conversation the box keeps a live session for; none for work outside it (one call, nothing kept). */
  conversation?: string;
  /** Sends a turn to the box (its WebSocket, box-hub.ts) and answers with its NDJSON stream. The API key stays on the box machine. */
  send(body: string, signal?: AbortSignal): Promise<Response>;
  /** What long-term memory brings up for what was said ("" for nothing). */
  recall?(said: string): Promise<string>;
  /** For their own turns, after the reply: what was said and what was answered. */
  record?(said: string, reply: string): void;
  /** What Kiro reported for the turn, in credits. */
  credits?(credits: number): void;
};

/** Why the box turned a turn down (the box already took the key out of what it says). */
export function kiroError(message: string): string {
  const text = message.trim() || "Kiro did not reply this turn";
  if (/unauthor|invalid.*(key|token)|not logged in|401|403/i.test(text)) return `Kiro did not accept the API key: make a new one and put it on the box machine (${text})`;
  if (/credit|limit|quota|429/i.test(text)) return `Kiro credits or limit reached: ${text}`;
  return `Kiro turn failed: ${text}`;
}

/** The Messages API events of a reply, built from the box's lines one at a time. */
function replyEvents(model: string) {
  let opened = false;
  let index = -1;
  // The kind of block that is open: Kiro's thoughts become a thinking block, as on the Claude box.
  let block: "text" | "thinking" | null = null;
  let calls = 0;
  const out: StreamEvent[] = [];
  const open = () => {
    if (opened) return;
    opened = true;
    out.push({ type: "message_start", message: { id: `kiro_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const closeBlock = () => {
    if (block) out.push({ type: "content_block_stop", index });
    block = null;
  };
  const piece = (kind: "text" | "thinking", delta: StreamEvent) => {
    open();
    if (block !== kind) {
      closeBlock();
      out.push({ type: "content_block_start", index: (index += 1), content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" } });
      block = kind;
    }
    out.push({ ...delta, index });
  };
  return {
    get opened() {
      return opened;
    },
    text(chunk: string) {
      piece("text", { type: "content_block_delta", delta: { type: "text_delta", text: chunk } });
    },
    thought(chunk: string) {
      piece("thinking", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: chunk } });
    },
    tool(use: { id?: unknown; name?: unknown; input?: unknown }) {
      open();
      closeBlock();
      calls += 1;
      out.push({ type: "content_block_start", index: (index += 1), content_block: { type: "tool_use", id: String(use.id), name: String(use.name), input: {} } });
      out.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(use.input ?? {}) } });
      out.push({ type: "content_block_stop", index });
    },
    end() {
      closeBlock();
      out.push({ type: "message_delta", delta: { stop_reason: calls ? "tool_use" : "end_turn" }, usage: { output_tokens: 0 } });
      out.push({ type: "message_stop" });
    },
    take(): StreamEvent[] {
      return out.splice(0);
    }
  };
}

/** The fetch the Anthropic provider uses: every request becomes a turn in the box. */
export function kiroFetch(turn: KiroTurn): typeof fetch {
  return async (_input, init) => {
    if (typeof init?.body !== "string") return refusal(400, "Kiro takes conversation only");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const model = String(body.model ?? "");
    const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
    if (messages.at(-1)?.role !== "user") return refusal(400, "Nothing new to reply to");
    const { said, before, hers, goesOn } = turnOf(messages);
    // Recalled once, when the user's turn begins.
    const note = hers && !goesOn && turn.recall ? await turn.recall(said).catch(() => "") : "";
    const request = JSON.stringify({
      model,
      system: systemText(body.system),
      tools: ownTools(body.tools),
      ...(turn.conversation ? { conversation: turn.conversation } : {}),
      messages: await boxMessages(messages),
      ...(note ? { note } : {}),
      results: resultsIn(messages.at(-1))
    });
    const abandon = () => {
      throw init.signal?.reason ?? new DOMException("The call was aborted", "AbortError");
    };
    let response: Response;
    try {
      response = await turn.send(request, init.signal ?? undefined);
    } catch (error) {
      if (init.signal?.aborted) abandon();
      return refusal(503, `Kiro box not reachable: ${kiroError(error instanceof Error ? error.message : String(error))}`);
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let reason = text;
      try {
        reason = String((JSON.parse(text) as { error?: unknown }).error ?? text);
      } catch {
        // Not JSON: the text as it is.
      }
      return refusal(response.status >= 500 ? 503 : 400, `Kiro box refused the turn (${response.status}): ${kiroError(reason).slice(0, 300)}`);
    }
    const stop = new AbortController();
    init.signal?.addEventListener("abort", () => stop.abort(init.signal?.reason), { once: true });
    const stream = lines(response.body, stop.signal);
    const reply = replyEvents(model);
    const all: StreamEvent[] = [];
    let finished = false;
    let called = false;
    /** The stream events one box line makes. */
    const take = (line: Record<string, unknown>): { events: StreamEvent[]; error?: string } => {
      if (typeof line.thought === "string" && line.thought) reply.thought(line.thought);
      if (typeof line.text === "string" && line.text) reply.text(line.text);
      if (line.tool && typeof line.tool === "object") {
        called = true;
        reply.tool(line.tool as Record<string, unknown>);
      }
      if (typeof line.error === "string") return { events: reply.take(), error: kiroError(line.error) };
      const done = line.done as { credits?: unknown } | undefined;
      if (done) {
        finished = true;
        if (typeof done.credits === "number" && Number.isFinite(done.credits)) turn.credits?.(done.credits);
        if (reply.opened) reply.end();
      }
      const events = reply.take();
      all.push(...events);
      return { events };
    };
    const finish = (): void => {
      // A reply that stopped at calls is recorded once the turn has its last words.
      if (called || !hers || !turn.record) return;
      const text = `${before}${saidIn(messageOf(all).content)}`;
      if (text) turn.record(said, text);
    };
    try {
      if (body.stream !== true) {
        for (let line = await stream.next(); !line.done; line = await stream.next()) {
          const { error } = take(line.value);
          if (error) return refusal(400, error);
          if (finished) break;
        }
        if (init.signal?.aborted) abandon();
        if (!finished || !reply.opened) return refusal(503, "Kiro box ended without a reply");
        finish();
        return Response.json(messageOf(all));
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
              if (!stop.signal.aborted) controller.enqueue(sse({ type: "error", error: { type: "api_error", message: kiroError(String(error)) } }));
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
      return refusal(503, `Kiro box connection broke: ${kiroError(String(error))}`);
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
