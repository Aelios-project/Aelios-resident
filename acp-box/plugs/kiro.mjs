// The Kiro plug of the ACP box: how to start `kiro-cli acp` and what to set up around it.
//
// A plug is a default export with these parts; the box core (server.mjs, run.mjs) knows nothing else of a helper:
//   name              the id a turn names it by (`helper`), and the folder the helper's homes are kept under
//   problem(turn)     why a turn cannot run (a missing key, a bad model id), or null
//   setup(run)        writes what the helper needs into run.home: its agent or config, its sign-in
//                     run = { home, key, system, tool }, tool = { url, secret, timeoutMs } of the resident's MCP server, or null
//   launch(run)       { command, args, env, cwd } of the ACP process; model is run.model
//   credits(method, params)   what a notification of the helper reports for the turn, in credits (null for none)
//
// Kiro here has no built-in tool and no MCP server but the resident's own, and trusts only that one. It keeps its
// own base prompt under the agent's `prompt`; that cannot be removed.

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TOOL_SERVER } from "../tools.mjs";

const AGENT_NAME = "resident";
// Model ids the box passes on: no leading dash, so one can never be read as a flag.
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Only what kiro-cli needs from the machine's own environment (and, behind a proxy, its proxy settings).
const PASSED = ["PATH", "LANG", "TZ", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
// Where kiro-cli keeps its sign-in, under a home.
const LOGIN_FILE = process.platform === "darwin" ? "Library/Application Support/kiro-cli/data.sqlite3" : ".local/share/kiro-cli/data.sqlite3";

/**
 * The agent config written for one run (CLI agent configuration): the resident's system prompt, an explicit `tools`
 * list (leaving the field out makes the model invent tool calls) that holds only the resident's MCP server when
 * there is one, not the global mcp.json, and no resources, so no steering or rule file loads.
 */
export function agentConfig(system, tool = null) {
  const trusted = tool ? [`@${TOOL_SERVER}`] : [];
  return {
    name: AGENT_NAME,
    description: "The resident.",
    prompt: String(system ?? ""),
    tools: trusted,
    allowedTools: trusted,
    mcpServers: tool ? { [TOOL_SERVER]: { url: tool.url, headers: { authorization: `Bearer ${tool.secret}` }, timeout: tool.timeoutMs } } : {},
    includeMcpJson: false,
    resources: []
  };
}

/** The command line: Kiro as an ACP agent, trusting the resident's tools only (`--trust-tools=` trusts none). */
export function kiroArgs(model, tools) {
  return ["acp", "--agent", AGENT_NAME, "--model", model, tools ? `--trust-tools=@${TOOL_SERVER}` : "--trust-tools="];
}

/** The environment of the process: its own home, and the API key. Nothing else of the machine's but the names above. */
export function kiroEnv(key, home, parent = process.env) {
  const env = { HOME: home, NO_COLOR: "1", ...(key ? { KIRO_API_KEY: key } : {}) };
  for (const name of PASSED) if (parent[name]) env[name] = parent[name];
  return env;
}

/**
 * TEST SWITCH, off by default: with KIRO_BOX_LOCAL_LOGIN=1 and no API key, the home gets a copy of this machine's
 * own `kiro-cli login`, so the box can be tried without a key. A real box uses KIRO_API_KEY.
 */
export async function copyLogin(home, env = process.env) {
  if (env.KIRO_BOX_LOCAL_LOGIN !== "1") return;
  const to = join(home, LOGIN_FILE);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(join(env.KIRO_BOX_LOGIN_HOME || homedir(), LOGIN_FILE), to);
}

/** The credits one `_kiro.dev/metadata` notification reports for the turn (null for none). */
export function creditsOf(params) {
  const usage = params?.meteringUsage;
  if (!Array.isArray(usage)) return null;
  const sum = usage.reduce((total, item) => total + (item?.unit === "credit" && Number.isFinite(item.value) ? item.value : 0), 0);
  return sum > 0 ? sum : null;
}

export default {
  name: "kiro",
  problem(turn) {
    if (!turn.key?.trim() && process.env.KIRO_BOX_LOCAL_LOGIN !== "1") return "KIRO_API_KEY is not set on the box machine";
    if (typeof turn.model !== "string" || !MODEL_PATTERN.test(turn.model)) return "model is missing or not a valid Kiro model id";
    return null;
  },
  async setup({ home, key, system, tool }) {
    await mkdir(join(home, ".kiro", "agents"), { recursive: true });
    await writeFile(join(home, ".kiro", "agents", `${AGENT_NAME}.json`), JSON.stringify(agentConfig(system, tool)), { mode: 0o600 });
    if (!key) await copyLogin(home);
  },
  launch({ home, key, model, tool }) {
    // Overridable so tests can run a fake process; a real box leaves it alone.
    return { command: process.env.KIRO_BIN || "kiro-cli", args: kiroArgs(model, Boolean(tool)), env: kiroEnv(key, home), cwd: join(home, "work") };
  },
  credits(method, params) {
    return method === "_kiro.dev/metadata" ? creditsOf(params) : null;
  }
};
