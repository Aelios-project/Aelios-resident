// The first-start question for a helper's key: asked on the terminal only, the typing not shown, and the answer goes
// straight to creds.json (config.mjs). Skipped when there is no terminal (a service) or the answer is empty.
import readline from "node:readline";
import { Writable } from "node:stream";

const LABELS = { kiro: "Kiro API key (ksk_…)", claude: "Claude setup token (from `claude setup-token`)" };

export function terminalAsk(input = process.stdin, output = process.stderr) {
  if (!input.isTTY) return undefined;
  return (plug, variable) =>
    new Promise((resolve) => {
      let shown = true;
      const muted = new Writable({ write(chunk, _encoding, done) { if (shown) output.write(chunk); done(); } });
      const rl = readline.createInterface({ input, output: muted, terminal: true });
      output.write(`${variable} is not set. ${LABELS[plug] ?? plug} (Enter to skip; it stays on this machine): `);
      shown = false;
      rl.question("", (answer) => {
        output.write("\n");
        rl.close();
        resolve(answer);
      });
    });
}
