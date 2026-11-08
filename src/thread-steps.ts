// What a thread on their machine is doing right now, as the runner reports it (Aelios-desktop, packages/runner/PROTOCOL.md,
// `progress`): a short line per step, a kind and a title ("read src/parser.js", "ran npm test", "edited 2 files"). Never file
// contents or command output; the runner hides secrets before it sends, and the last ~10 steps are all that is kept. They
// show on the thread's card and page while it works, and the resident's own find tool returns them, so it can say what the
// thread just did. They are dropped when the turn ends.
import type { Sql } from "./sticker-store";

export const STEP_KINDS = ["read", "edit", "run", "search", "fetch", "think", "other"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export type Step = { kind: StepKind; title: string };

export const STEPS_KEPT = 10;
export const STEP_TITLE_MAX = 80;

/** A progress body, or an error text. Strict: a field the protocol does not name is refused. */
export function progressOf(body: Record<string, unknown>): { workId: string; token: string; steps: Step[] } | string {
  if (Object.keys(body).some((key) => !["workId", "token", "steps"].includes(key))) return "the progress has a field the protocol does not name";
  const { workId, token, steps } = body;
  if (typeof workId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(workId) || typeof token !== "string" || !token || token.length > 200) return "workId or token is not valid";
  if (!Array.isArray(steps) || steps.length > STEPS_KEPT) return `steps is a list of up to ${STEPS_KEPT}`;
  const out: Step[] = [];
  for (const step of steps) {
    const item = step as Record<string, unknown> | null;
    if (!item || typeof item !== "object" || Object.keys(item).some((key) => key !== "kind" && key !== "title")) return "a step is a kind and a title";
    const title = typeof item.title === "string" ? item.title.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim() : "";
    if (!STEP_KINDS.includes(item.kind as StepKind) || !title || title.length > STEP_TITLE_MAX) return `a step's kind is one of ${STEP_KINDS.join(", ")}, its title 1 to ${STEP_TITLE_MAX} characters`;
    out.push({ kind: item.kind as StepKind, title });
  }
  return { workId, token, steps: out };
}

export class StepStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_thread_steps (thread TEXT PRIMARY KEY, steps TEXT NOT NULL, at INTEGER NOT NULL)`;
  }

  set(thread: string, steps: Step[]): void {
    this.sql`INSERT INTO res_thread_steps VALUES (${thread}, ${JSON.stringify(steps)}, ${Date.now()}) ON CONFLICT(thread) DO UPDATE SET steps = excluded.steps, at = excluded.at`;
  }

  clear(thread: string): void {
    this.sql`DELETE FROM res_thread_steps WHERE thread = ${thread}`;
  }

  /** The newest `count` steps, oldest first. */
  last(thread: string, count = STEPS_KEPT): Step[] {
    const [row] = this.sql<{ steps: string }>`SELECT steps FROM res_thread_steps WHERE thread = ${thread}`;
    return row ? (JSON.parse(row.steps) as Step[]).slice(-count) : [];
  }
}
