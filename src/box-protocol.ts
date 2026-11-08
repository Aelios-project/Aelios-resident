// The wire between the resident's box hub (box-hub.ts) and a box (acp-box/), `aelios-box/1`. The box dials out: it
// opens a WebSocket to the resident and keeps it. Frames are JSON text. A frame with a field the protocol does not
// name is refused, and nothing in a frame is ever a credential: the helper's keys stay on the box machine.
//
//   box -> resident   { t: "hello", proto, name, plugs, down }   first frame: the machine's name, the plugs it offers, and
//                                                          the plugs it has but cannot use now ({ plug: one-line reason })
//                     { t: "line", id, line }              one NDJSON line of turn `id` (text, tool, done, error …)
//                     { t: "end", id }                     turn `id` is over
//   resident -> box   { t: "turn", id, plug, body }        a turn for one plug; `body` is what the plug takes
//                     { t: "cancel", id }                  stop turn `id`
//
// "ping" / "pong" are plain strings answered by the runtime without waking the hub (hibernation).

export const BOX_PROTOCOL = "aelios-box/1";
export const PLUG_NAME = /^[a-z][a-z0-9-]{0,19}$/;
export const TURN_ID = /^[0-9a-f]{32}$/;
export const BOX_NAME_MAX = 60;
export const MAX_PLUGS = 8;
export const REASON_MAX = 140;
/** Close code for a box whose token was revoked or is wrong: it stops for good. */
export const CLOSE_REVOKED = 4401;
/** Close code for a box that sent a frame the protocol does not allow. */
export const CLOSE_PROTOCOL = 4400;

/** The plug that serves a model id, by its prefix; null for a model no box serves. */
const PREFIXES: [string, string][] = [
  ["kiro/", "kiro"],
  ["claude-code/", "claude"]
];
export function plugOfModel(id: string): string | null {
  return PREFIXES.find(([prefix]) => id.startsWith(prefix))?.[1] ?? null;
}

export type BoxFrame =
  | { t: "hello"; proto: string; name: string; plugs: string[]; down: Record<string, string> }
  | { t: "line"; id: string; line: Record<string, unknown> }
  | { t: "end"; id: string };

const FIELDS: Record<string, string[]> = { hello: ["t", "proto", "name", "plugs", "down"], line: ["t", "id", "line"], end: ["t", "id"] };

/** A frame of a box, or null when it is not one the protocol names (unknown field, wrong type, bad id). */
export function parseBoxFrame(raw: string | ArrayBuffer): BoxFrame | null {
  if (typeof raw !== "string") return null;
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  const body = frame as Record<string, unknown>;
  const allowed = typeof body.t === "string" ? FIELDS[body.t] : undefined;
  if (!allowed || Object.keys(body).some((key) => !allowed.includes(key))) return null;
  if (body.t === "hello") {
    const { proto, name, plugs } = body;
    if (proto !== BOX_PROTOCOL || typeof name !== "string" || !Array.isArray(plugs)) return null;
    if (plugs.length > MAX_PLUGS || plugs.some((plug) => typeof plug !== "string" || !PLUG_NAME.test(plug))) return null;
    // eslint-disable-next-line no-control-regex
    const clean = name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, BOX_NAME_MAX) || "Box";
    const down: Record<string, string> = {};
    const given = body.down === undefined ? {} : body.down;
    if (!given || typeof given !== "object" || Array.isArray(given) || Object.keys(given).length > MAX_PLUGS) return null;
    for (const [plug, reason] of Object.entries(given)) {
      if (!PLUG_NAME.test(plug) || typeof reason !== "string") return null;
      // eslint-disable-next-line no-control-regex
      down[plug] = reason.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, REASON_MAX);
    }
    return { t: "hello", proto, name: clean, plugs: [...new Set(plugs as string[])].filter((plug) => !(plug in down)), down };
  }
  if (typeof body.id !== "string" || !TURN_ID.test(body.id)) return null;
  if (body.t === "end") return { t: "end", id: body.id };
  if (!body.line || typeof body.line !== "object" || Array.isArray(body.line)) return null;
  return { t: "line", id: body.id, line: body.line as Record<string, unknown> };
}
