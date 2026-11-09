// A turn through a helper that speaks ACP (Agent Client Protocol), signed in with the owner's own account. Today the
// plug is Kiro (plugs/kiro.mjs, `kiro-cli acp` on the owner's Kiro credits). A turn arrives over the box's outbound
// socket (link.mjs) as
//   { model, system, tools?, conversation?, messages, note?, results? }
// and its reply goes back as lines:
//                    { "text": "…" } …                    a piece of the reply
//                    { "tool": { id, name, input } } …    a call of the resident's tools the reply stops at
//                    { "done": { "credits": n } }          the reply ended (n: what the helper reports, or null)
//                    { "error": "…" }                      instead of done when the turn failed
// The API key is not in the turn: the box adds its own (engines.mjs).
//
// messages is the conversation as [{ who: "User" | "You", text, mark, images? }], mark a hash of the conversation up to that
// message. With a conversation id, the box keeps one live helper session for it while it runs and sends only what is
// new (session.mjs, prompt.mjs); without one, the turn is on its own. Nothing is written down: the cloud keeps the
// conversation, and a session that is gone is seeded again from it. tools are the resident's (Messages API
// definitions); results are the tool_result blocks that answer the calls the reply before stopped at.

import { messagesProblem, plan } from "./prompt.mjs";
import kiro from "./plugs/kiro.mjs";
import { byCall, byConversation, fingerprintOf, scrub, Session } from "./session.mjs";

// A helper is a plug here; a later one (another ACP agent) is added to this list.
const PLUGS = new Map([kiro].map((plug) => [plug.name, plug]));

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
