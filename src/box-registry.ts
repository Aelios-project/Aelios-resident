// The boxes paired with a resident: pairing code -> box token, who is paired, which box serves which plug. The same
// pairing as the runner's (machine.ts): a one-time code from the settings page (10 minutes), traded once for the box's
// own long-lived token. Only a hash of the token is kept; a revoked box's token is refused from then on.
// Whether a box is online is the hub's to say (box-hub.ts): it holds the sockets. Plain SQL in, so a test runs it on
// Node's SQLite.
import type { Sql } from "./sticker-store";
import { BOX_NAME_MAX, MAX_PLUGS, PLUG_NAME, REASON_MAX } from "./box-protocol";

const CODE_MS = 10 * 60_000;
const MAX_BOXES = 8;
const TRIES = 10;
const TRIES_MS = 10 * 60_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class BoxError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new BoxError(status, code, message);
};

type Row = { id: string; token_hash: string; name: string; plugs: string; down: string; created_at: number; last_seen_at: number | null; connected_at: number | null; revoked_at: number | null };
export type BoxInfo = { id: string; name: string; plugs: string[]; unavailable: Record<string, string>; pairedAt: number; lastSeenAt: number | null; connectedAt: number | null; online: boolean; serves: string[] };

const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Compares two equal-length hex digests without stopping at the first difference. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// eslint-disable-next-line no-control-regex
const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max) : "");
const plugsOf = (row: Row): string[] => JSON.parse(row.plugs) as string[];

export class BoxRegistry {
  constructor(private readonly sql: Sql, private readonly atomic: <T>(fn: () => T) => T = (fn) => fn()) {
    this.sql`CREATE TABLE IF NOT EXISTS res_box (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, plugs TEXT NOT NULL, down TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, last_seen_at INTEGER, connected_at INTEGER, revoked_at INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS res_box_code (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS res_box_serve (plug TEXT PRIMARY KEY, box_id TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS res_box_tries (at INTEGER NOT NULL)`;
  }

  /** A one-time pairing code, good for 10 minutes. Several may be open at once. */
  async code(): Promise<{ code: string; expiresAt: number }> {
    const letters = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
    const expiresAt = Date.now() + CODE_MS;
    const codeHash = await hash(letters);
    this.atomic(() => {
      this.sql`DELETE FROM res_box_code WHERE expires_at < ${Date.now()}`;
      this.sql`INSERT INTO res_box_code VALUES (${codeHash}, ${expiresAt})`;
    });
    return { code, expiresAt };
  }

  /** Trades a code for a box token. The code is used up; wrong codes are counted, and too many are turned away. */
  async pair(input: unknown): Promise<{ boxId: string; token: string }> {
    const body = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : fail(400, "INVALID_BODY", "the body must be a JSON object");
    if (Object.keys(body).some((key) => !["code", "name"].includes(key))) fail(400, "INVALID_BODY", "the body has a field the protocol does not name");
    const letters = typeof body.code === "string" ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const codeHash = await hash(letters);
    const id = hex(8);
    const token = `bt_${id}.${hex(32)}`;
    const tokenHash = await hash(token);
    const name = clean(body.name, BOX_NAME_MAX) || "Box";
    // A wrong code is counted outside the transaction below: a failure inside it would roll the count back.
    const now = Date.now();
    this.sql`DELETE FROM res_box_tries WHERE at < ${now - TRIES_MS}`;
    if (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM res_box_tries`[0].n >= TRIES) fail(429, "TOO_MANY_TRIES", "试了太多次，等几分钟再来");
    const [found] = this.sql<{ expires_at: number }>`SELECT expires_at FROM res_box_code WHERE code_hash = ${codeHash}`;
    if (!found || found.expires_at < now) {
      this.sql`INSERT INTO res_box_tries VALUES (${now})`;
      fail(403, "BAD_CODE", "配对码不对或过期了，在设置页重新生成一个");
    }
    return this.atomic(() => {
      if (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM res_box WHERE revoked_at IS NULL`[0].n >= MAX_BOXES) fail(409, "TOO_MANY_BOXES", `最多配 ${MAX_BOXES} 台盒子，先撤销一台`);
      this.sql`DELETE FROM res_box_code WHERE code_hash = ${codeHash}`;
      this.sql`INSERT INTO res_box VALUES (${id}, ${tokenHash}, ${name}, ${"[]"}, ${"{}"}, ${now}, ${null}, ${null}, ${null})`;
      return { boxId: id, token };
    });
  }

  /** The box a token belongs to, or null (unknown, wrong, or revoked). Compares the digests in constant time. */
  async authenticate(token: string): Promise<{ id: string; name: string; plugs: string[] } | null> {
    const id = token.match(/^bt_([0-9a-f]{16})\.[0-9a-f]{64}$/)?.[1];
    const given = id ? await hash(token) : "";
    const [row] = id ? this.sql<Row>`SELECT * FROM res_box WHERE id = ${id}` : [];
    // A digest is compared even when there is no such box, so the answer takes the same time.
    const ok = same(row?.token_hash ?? "0".repeat(64), given || "1".repeat(64)) && Boolean(row) && row.revoked_at === null;
    return ok ? { id: row.id, name: row.name, plugs: plugsOf(row) } : null;
  }

  /** A box connected and said who it is: its name and plugs are kept, and it counts as seen and just connected. */
  hello(id: string, name: string, plugs: string[], down: Record<string, string> = {}): void {
    const now = Date.now();
    this.sql`UPDATE res_box SET name = ${clean(name, BOX_NAME_MAX) || "Box"}, plugs = ${JSON.stringify(plugs.filter((p) => PLUG_NAME.test(p)).slice(0, MAX_PLUGS))}, down = ${JSON.stringify(Object.fromEntries(Object.entries(down).filter(([plug]) => PLUG_NAME.test(plug)).map(([plug, why]) => [plug, why.slice(0, REASON_MAX)])))}, last_seen_at = ${now}, connected_at = ${now} WHERE id = ${id} AND revoked_at IS NULL`;
  }

  seen(id: string): void {
    this.sql`UPDATE res_box SET last_seen_at = ${Date.now()} WHERE id = ${id}`;
  }

  /** Revoked: the token answers nothing from now on, and what it served falls back to the default. */
  revoke(id: string): void {
    this.atomic(() => {
      if (!this.sql<Row>`SELECT * FROM res_box WHERE id = ${id} AND revoked_at IS NULL`.length) fail(404, "UNKNOWN_BOX", "没有这台盒子");
      this.sql`UPDATE res_box SET revoked_at = ${Date.now()} WHERE id = ${id}`;
      this.sql`DELETE FROM res_box_serve WHERE box_id = ${id}`;
    });
  }

  /** Which box serves a plug when more than one offers it; "" goes back to the default (the newest connected). */
  serve(plug: string, id: string): void {
    this.atomic(() => {
      if (!PLUG_NAME.test(plug)) fail(400, "INVALID_PLUG", "no such plug");
      if (!id) return void this.sql`DELETE FROM res_box_serve WHERE plug = ${plug}`;
      const [row] = this.sql<Row>`SELECT * FROM res_box WHERE id = ${id} AND revoked_at IS NULL`;
      if (!row || !plugsOf(row).includes(plug)) fail(400, "NOT_OFFERED", "这台盒子没有这个插头");
      this.sql`INSERT OR REPLACE INTO res_box_serve VALUES (${plug}, ${id})`;
    });
  }

  /** The box that serves a plug now, among the online ones (id -> true); null when none offers it. */
  pick(plug: string, online: ReadonlySet<string>): { id: string; name: string } | null {
    const rows = this.sql<Row>`SELECT * FROM res_box WHERE revoked_at IS NULL`.filter((row) => online.has(row.id) && plugsOf(row).includes(plug));
    const chosen = this.sql<{ box_id: string }>`SELECT box_id FROM res_box_serve WHERE plug = ${plug}`[0]?.box_id;
    const row = rows.find((one) => one.id === chosen) ?? rows.sort((a, b) => (b.connected_at ?? 0) - (a.connected_at ?? 0))[0];
    return row ? { id: row.id, name: row.name } : null;
  }

  /** The settings page's list: every paired box, with the plugs it serves now. */
  list(online: ReadonlySet<string>): BoxInfo[] {
    const rows = this.sql<Row>`SELECT * FROM res_box WHERE revoked_at IS NULL ORDER BY created_at`;
    const plugs = [...new Set(rows.flatMap(plugsOf))];
    const servedBy = new Map(plugs.map((plug) => [plug, this.pick(plug, online)?.id]));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      plugs: plugsOf(row),
      unavailable: JSON.parse(row.down) as Record<string, string>,
      pairedAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      connectedAt: row.connected_at,
      online: online.has(row.id),
      serves: plugsOf(row).filter((plug) => servedBy.get(plug) === row.id)
    }));
  }
}

/** A BoxError as an answer; anything else is a bug and is thrown on. */
export async function boxReply<T>(operation: () => T | Promise<T>): Promise<{ status: number; body: unknown }> {
  try {
    return { status: 200, body: await operation() };
  } catch (error) {
    if (error instanceof BoxError) return { status: error.status, body: { error: error.message, code: error.code } };
    throw error;
  }
}
