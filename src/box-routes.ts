// The box addresses of the Worker, handed to the resident's box hub (box-hub.ts), one hub per resident:
//   GET  /web/boxes                    the paired boxes: name, plugs, online, last seen, which serves what   (web key)
//   POST /web/boxes/code               a one-time pairing code, 10 minutes                                   (web key)
//   POST /web/boxes/revoke {id}        unpair a box; its socket closes at once                               (web key)
//   POST /web/boxes/serve {plug, id}   which box serves a plug when two offer it; id "" = the newest        (web key)
//   POST /box/v1/pair {code, name}     a box trades the code for its own token (the code is the credential)
//   GET  /box/v1/link                  the box's WebSocket, `Authorization: Bearer <box token>`
import { BOX_PROTOCOL } from "./box-protocol";

const BODY_MAX = 4 * 1024;

/** The resident's hub. */
export const boxHub = (env: Env, residentId: string) => env.BOXES.get(env.BOXES.idFromName(residentId));

const answer = (done: { status: number; body: unknown }) => Response.json(done.body, { status: done.status, headers: { "cache-control": "no-store" } });

/** The settings page's calls, after the web key was checked. `body` is the page's parsed JSON. */
export async function boxWeb(env: Env, residentId: string, method: string, path: string, body: { id?: string; plug?: string }): Promise<Response | null> {
  const hub = boxHub(env, residentId);
  if (method === "GET" && path === "/web/boxes") return Response.json(await hub.list(), { headers: { "cache-control": "no-store" } });
  if (method !== "POST") return null;
  if (path === "/web/boxes/code") return answer(await hub.code());
  if (path === "/web/boxes/revoke") return answer(await hub.revoke(String(body.id ?? "")));
  if (path === "/web/boxes/serve") return answer(await hub.serve(String(body.plug ?? ""), String(body.id ?? "")));
  return null;
}

/** The box's own calls: pairing (no credential but the code) and the socket (its token). */
export async function boxPublic(request: Request, env: Env, residentId: string, path: string): Promise<Response> {
  const hub = boxHub(env, residentId);
  if (path === "/box/v1/pair") {
    if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
    const text = await request.text();
    if (text.length > BODY_MAX) return Response.json({ error: "request too large", code: "BODY_TOO_LARGE" }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "the body must be JSON", code: "INVALID_JSON" }, { status: 400 });
    }
    const done = (await hub.pair(body)) as { status: number; body: unknown };
    return answer(done.status === 200 ? { status: 200, body: { ...(done.body as object), protocol: BOX_PROTOCOL } } : done);
  }
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "a WebSocket is expected" }, { status: 426 });
  return hub.fetch(request);
}
