// What the box keeps on its own machine, in one folder (mode 0700, files 0600):
//   box.json    { resident, token }   where to dial, and this box's own long-lived token (traded for the pairing code once)
//   creds.json  { KIRO_API_KEY, CLAUDE_CODE_OAUTH_TOKEN }   the helpers' keys, if they were typed in rather than set in
//               the environment. They are read here and handed to the helper; they are never sent to the resident,
//               never logged, never put in an error.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The credential each plug needs, by the environment variable that holds it. */
export const CREDENTIALS = { kiro: "KIRO_API_KEY", claude: "CLAUDE_CODE_OAUTH_TOKEN" };

export const configDir = (env = process.env) => env.AELIOS_BOX_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "aelios-box");

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${file} cannot be read: ${error.message}`);
  }
}

/** Writes a file only its owner can read, also when it already existed with other rights. */
export async function writePrivate(dir, name, data) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const file = join(dir, name);
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export const loadLink = (dir) => readJson(join(dir, "box.json"));
export const saveLink = (dir, link) => writePrivate(dir, "box.json", link);

/**
 * The helpers' keys: the environment first, then creds.json. `ask(plug, variable)` may type one in at the first start
 * (it answers "" to skip); what it answers is kept in creds.json.
 */
export async function loadCredentials(dir, { env = process.env, ask } = {}) {
  const saved = (await readJson(join(dir, "creds.json"))) ?? {};
  const found = {};
  let typed = false;
  for (const [plug, name] of Object.entries(CREDENTIALS)) {
    let value = (env[name] || saved[name] || "").trim();
    if (!value && ask) {
      value = ((await ask(plug, name)) || "").trim();
      if (value) {
        saved[name] = value;
        typed = true;
      }
    }
    if (value) found[plug] = value;
  }
  if (typed) await writePrivate(dir, "creds.json", saved);
  return found;
}
