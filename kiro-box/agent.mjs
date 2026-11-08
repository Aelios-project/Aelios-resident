// What the Kiro box tells kiro-cli: the stripped-down agent, the command line, the environment, and how its
// `--output-format stream-json` events are read. Nothing here starts a process (server.mjs does).
//
// The resident is a personal secretary agent: it reads messages, decides, and hands work to threads. Inside the box
// no tool is trusted, so Kiro here only talks. Kiro keeps its own base prompt under the agent's `prompt`; that
// cannot be removed.

export const AGENT_NAME = "resident";
// Model ids the box passes on: no leading dash, so one can never be read as a flag.
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A conversation longer than this loses its oldest part (the command line has a size limit).
// shortcut: the prompt goes in argv, so it is capped; move to stdin or ACP if kiro-cli takes a longer prompt there.
export const PROMPT_MAX_CHARS = 100_000;
// Only what kiro-cli needs from the machine's own environment (and, behind a proxy, its proxy settings).
const PASSED = ["PATH", "LANG", "TZ", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

/**
 * The agent config written for one turn (CLI agent configuration): the resident's system prompt, an explicit empty
 * `tools` list (leaving the field out makes the model invent tool calls), no MCP servers and not the global
 * mcp.json, and no resources, so no steering or rule file loads.
 */
export function agentConfig(system) {
  return {
    name: AGENT_NAME,
    description: "The resident, talking only.",
    prompt: String(system ?? ""),
    tools: [],
    allowedTools: [],
    mcpServers: {},
    includeMcpJson: false,
    resources: []
  };
}

/** The command line of one turn. `--trust-tools=` with nothing after it trusts no tool at all. */
export function kiroArgs(model, prompt) {
  const text = String(prompt);
  return [
    "chat",
    "--no-interactive",
    "--output-format",
    "stream-json",
    "--agent",
    AGENT_NAME,
    "--trust-tools=",
    "--model",
    model,
    // A prompt that starts with a dash is not read as an option.
    text.startsWith("-") ? ` ${text}` : text
  ];
}

/** The environment of the kiro-cli process: a home of its own for this turn, and the API key. */
export function kiroEnv(key, home, parent = process.env) {
  const env = { HOME: home, NO_COLOR: "1", KIRO_API_KEY: key };
  for (const name of PASSED) if (parent[name]) env[name] = parent[name];
  return env;
}

/** The text with the API key taken out, for anything that is logged or sent back. */
export function scrub(text, key) {
  const clean = String(text ?? "");
  return key ? clean.split(key).join("[key]") : clean;
}

function creditsIn(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (node.unit === "credit" && Number.isFinite(node.usage)) return node.usage;
  for (const value of Object.values(node)) {
    const found = creditsIn(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * What one stream-json line gives: reply text (an ACP agent_message_chunk) and the credits Kiro reports for the
 * turn (an object with unit "credit" and a usage number). Thoughts, tool events and anything else give nothing.
 * Not checked against a real turn: the credits shape comes from Kiro's own session logs.
 */
export function readEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  const update = event?.params?.update ?? event?.update ?? event;
  const out = {};
  if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") out.text = update.content.text;
  const credits = creditsIn(event);
  if (credits !== null) out.credits = credits;
  return out;
}
