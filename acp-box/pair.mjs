// Pairing: the one-time code from the settings page is traded once for the box's own token. The code is the only
// credential on this request; the token it returns is kept in box.json (config.mjs) and nowhere else.
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";

/** The computer's name: macOS Computer Name, elsewhere the host name. At most 60 characters. */
export function computerName() {
  let name = "";
  if (process.platform === "darwin") {
    try {
      name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // Falls back to the host name.
    }
  }
  // eslint-disable-next-line no-control-regex
  return (name || hostname()).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 60) || "Box";
}

/** The resident's address as given (`https://host` or `https://host/r/<id>`): https, except to this machine itself. */
export function residentUrl(value) {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("the resident's address must start with https://");
  return url.href.replace(/\/+$/, "");
}

/** The WebSocket address of the same resident. */
export const linkUrl = (resident) => `${resident.replace(/^http/, "ws")}/box/v1/link`;

export async function pair({ resident, code, name = computerName(), fetchImpl = fetch }) {
  const response = await fetchImpl(`${resident}/box/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
    redirect: "manual"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.token !== "string") throw new Error(body.error ? `pairing refused: ${body.error}` : `pairing failed (${response.status})`);
  return { resident, token: body.token };
}
