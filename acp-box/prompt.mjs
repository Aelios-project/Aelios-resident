// What a turn says to the helper. The resident sends the conversation as messages ({ who, text, mark }, mark being a
// hash of the conversation up to and including that message). A helper session the box kept for the conversation only
// gets what is new; any other case (a new conversation, a compacted or edited one, a session that cannot be loaded)
// starts a session with the whole conversation as it stands.

export const PROMPT_MAX_CHARS = 100_000;
const HEAD = "The conversation so far is below. Reply as You, to the User's last message, and write only the reply.\n\n";

const say = (message) => `${message.who}: ${message.text}`;

/** Checks the messages of a turn; the reason they cannot run, or null. */
export function messagesProblem(messages, needMarks) {
  if (!Array.isArray(messages) || !messages.length) return "messages is empty";
  for (const message of messages) {
    if (!message || typeof message.text !== "string" || (message.who !== "User" && message.who !== "You")) return "a message is malformed";
    if (needMarks && typeof message.mark !== "string") return "a message has no mark";
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
  const spoken = messages.filter((message) => message.text);
  const body = spoken.map(say).join("\n\n");
  const seed = `${HEAD}${body.length > PROMPT_MAX_CHARS ? body.slice(-PROMPT_MAX_CHARS) : body}${tail}`;
  if (state && state.count >= 1 && messages[state.count - 1]?.mark === state.hash) {
    const from = messages[state.count]?.who === "You" ? state.count + 1 : state.count;
    const fresh = messages.slice(from).filter((message) => message.text);
    if (fresh.length) return { resume: true, input: `${fresh.map(say).join("\n\n")}${tail}`, seed };
  }
  return { resume: false, input: seed, seed };
}
