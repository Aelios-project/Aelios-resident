import type { Sql } from "./sticker-store";

export type RoleModel = { model: string; family?: string };

/** Add metadata to an existing role card without assigning a model or family. */
export function initRoleFamily(sql: Sql): void {
  if (!sql<{ n: number }>`SELECT COUNT(*) AS n FROM pragma_table_info('res_task_roles') WHERE name = 'family'`[0].n) {
    sql`ALTER TABLE res_task_roles ADD COLUMN family TEXT NOT NULL DEFAULT ''`;
  }
}

export function validFamily(value: unknown): value is string {
  return typeof value === "string" && (value === "" || (/^[a-z][a-z0-9-]{0,39}$/.test(value) && value.trim() === value));
}

/** Empty metadata remains absent for existing callers and older role cards. */
export function roleWithFamily<T extends RoleModel>(role: T): T {
  const { family, ...rest } = role;
  return (family ? { ...rest, family } : rest) as T;
}

/** Never infer a family from an id or select a default for an unconfigured card. */
export function roleModel(role: RoleModel | null): { model?: string; family?: string } {
  return role?.model ? { model: role.model, ...(role.family ? { family: role.family } : {}) } : {};
}
