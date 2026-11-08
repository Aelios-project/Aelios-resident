// The plugs this box can offer, each with a check for whether it can work on this machine right now and a way to run
// a turn. The helper's key comes from this machine (config.mjs), never from the turn: whatever the resident's turn says
// about keys is overwritten here. A plug that cannot work is announced as unavailable with a one-line reason (link.mjs
// puts it in `hello`), instead of failing every turn.
import { execFile } from "node:child_process";
import { problem, takeTurn } from "./kiro-turn.mjs";
import { turn as claudeTurn } from "./claude/run.mjs";

// Kiro's servers have no IPv6, so a Kiro plug needs IPv4 egress. Any answer (even a refusal) proves the way is open.
const KIRO_REACH = "https://q.us-east-1.amazonaws.com/";
export const KIRO_UNREACHABLE = "Kiro's servers cannot be reached from here: they have no IPv6, so this machine needs IPv4 egress (home network, or WARP)";
const run = (command, args) => new Promise((resolve) => execFile(command, args, { timeout: 5000 }, (error) => resolve(!error)));

/** Whether the machine reaches Kiro's endpoint over the network it has. */
export async function kiroReachable(fetchImpl = fetch, url = process.env.KIRO_REACH_URL || KIRO_REACH) {
  try {
    await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(8000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

/** The engines by plug name. `creds` is { kiro?, claude? } from this machine; `ctx` is the loopback server's { base }. */
export function createEngines(creds, ctx, { reachable = kiroReachable } = {}) {
  const forPlug = (plug) => ({ ...ctx, credential: () => creds[plug] ?? "" });
  return {
    kiro: {
      async check() {
        const local = process.env.KIRO_BOX_LOCAL_LOGIN === "1";
        if (!creds.kiro && !local) return "No Kiro API key on this machine (set KIRO_API_KEY)";
        if (!(await run(process.env.KIRO_BIN || "kiro-cli", ["--version"]))) return "kiro-cli is not installed on this machine";
        return (await reachable()) ? null : KIRO_UNREACHABLE;
      },
      async turn(body, write, signal) {
        // The key and the helper are this machine's choice, not the turn's.
        const turn = { ...body, helper: "kiro", key: creds.kiro ?? "" };
        const why = problem(turn);
        if (why) return void write({ error: why });
        await takeTurn(turn, write, signal, ctx);
      }
    },
    claude: {
      async check() {
        if (!creds.claude) return "No Claude setup token on this machine (set CLAUDE_CODE_OAUTH_TOKEN)";
        try {
          await import("@anthropic-ai/claude-agent-sdk");
        } catch {
          return "The Claude SDK is not installed here: run npm ci in the box folder";
        }
        return null;
      },
      turn: (body, write, signal) => claudeTurn(body, write, signal, forPlug("claude"))
    }
  };
}
