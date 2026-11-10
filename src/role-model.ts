// A role card's machine part: the model a machine's helper is asked to use for the role's jobs, and that model's family.
// It is kept apart from the card's `model`, which is the id the resident's own threads (and GitHub Actions) call through
// the gateway, such as anthropic/claude-sonnet-5.5. A helper only knows its own ids (Claude Code: claude-sonnet-4-6 or
// an alias such as sonnet), so one field cannot serve both.
import type { Sql } from "./sticker-store";

export type MachinePick = { machineModel?: string; family?: string };

/** Adds the two columns to a role table made before them, empty: no card gets a model or family it was not given. */
export function initRoleMachine(sql: Sql): void {
  const has = (name: string) => sql<{ n: number }>`SELECT COUNT(*) AS n FROM pragma_table_info('res_task_roles') WHERE name = ${name}`[0].n > 0;
  if (!has("family")) sql`ALTER TABLE res_task_roles ADD COLUMN family TEXT NOT NULL DEFAULT ''`;
  if (!has("machine_model")) sql`ALTER TABLE res_task_roles ADD COLUMN machine_model TEXT NOT NULL DEFAULT ''`;
}

export function validFamily(value: unknown): value is string {
  return typeof value === "string" && (value === "" || /^[a-z][a-z0-9-]{0,39}$/.test(value));
}

/** Empty values are left off, so a card without them reads as it did before. */
export function roleWithMachine<T extends MachinePick>(role: T): T {
  const { machineModel, family, ...rest } = role;
  return { ...rest, ...(machineModel ? { machineModel } : {}), ...(family ? { family } : {}) } as T;
}

/** What a machine job asks for: nothing unless the card names a machine model. Never guessed from the gateway model. */
export function machinePick(role: MachinePick | null): { model?: string; family?: string } {
  return role?.machineModel ? { model: role.machineModel, ...(role.family ? { family: role.family } : {}) } : {};
}
