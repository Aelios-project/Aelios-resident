// What a turn says to the helper. The resident sends messages ({ who, text, mark, images? }, mark being a
// hash of the conversation up to and including that message). A helper session the box kept for the conversation only
// gets what is new; any other case (a new conversation, a compacted or edited one, a session that cannot be loaded)
// starts a session with the whole conversation as it stands.

export const PROMPT_MAX_CHARS = 100_000;
const HEAD = "The conversation so far is below. Reply as You, to the User's last message, and write only the reply.\n\n";

const say = (message) => `${message.who}: ${message.text}`;

/** Keep images next to their message. Trim old text as before; images of wholly omitted messages leave with it. */
function inputOf(messages, head, tail, limit = Infinity) {
  const body = messages.map(say).join("\n\n");
  if (!messages.some((message) => message.images?.length)) return `${head}${body.slice(Math.max(0, body.length - limit))}${tail}`;
  let skip = Math.max(0, body.length - limit);
  const blocks = [{ type: "text", text: head }];
  for (const [index, message] of messages.entries()) {
    const text = `${index ? "\n\n" : ""}${say(message)}`;
    if (skip >= text.length) { skip -= text.length; continue; }
    blocks.push({ type: "text", text: text.slice(skip) });
    skip = 0;
    for (const image of message.images ?? []) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  if (tail) blocks.push({ type: "text", text: tail });
  return blocks.filter((block) => block.type !== "text" || block.text);
}

/** Checks the messages of a turn; the reason they cannot run, or null. */
export function messagesProblem(messages, needMarks) {
  if (!Array.isArray(messages) || !messages.length) return "messages is empty";
  for (const message of messages) {
    if (!message || typeof message.text !== "string" || (message.who !== "User" && message.who !== "You")) return "a message is malformed";
    if (needMarks && typeof message.mark !== "string") return "a message has no mark";
    if (message.images !== undefined && (!Array.isArray(message.images) || message.images.some((image) =>
      !image || image.type !== "image" || typeof image.data !== "string" || !image.data || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")))) return "a message has malformed images";
  }
  return null;
}

/**
 * `resume` says whether the live session still holds this conversation: `state` is the count of messages it was
 * told and the mark of the last one, and the messages must still have that mark there, with something new after it (the
 * helper's own last reply, which it knows, is skipped). `input` is the prompt for that session, `seed` the prompt for
 * a new one. `note` (what long-term memory brought up) goes with whichever is used.
 */
export function plan(messages, state, note = "") {
  const tail = note ? `\n\n${note}` : "";
  const spoken = messages.filter((message) => message.text || message.images?.length);
  const seed = inputOf(spoken, HEAD, tail, PROMPT_MAX_CHARS);
  if (state && state.count >= 1 && messages[state.count - 1]?.mark === state.hash) {
    const from = messages[state.count]?.who === "You" ? state.count + 1 : state.count;
    const fresh = messages.slice(from).filter((message) => message.text || message.images?.length);
    if (fresh.length) return { resume: true, input: inputOf(fresh, "", tail), seed };
  }
  return { resume: false, input: seed, seed };
}
