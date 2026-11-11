export type ChatTurn = { requestId: string; stopping: boolean };
export type StopResult = { status: "idle" | "stopping"; requestId?: string } | { error: string };
type RunningTurn = ChatTurn & { active: () => boolean };

/** Tracks the current chat turn across RPC calls; Think owns cancellation and execution. */
export class ChatStop {
  #turn: RunningTurn | null = null;
  #stopped = new Set<string>();

  start(requestId: string, active: () => boolean): void {
    this.#turn = { requestId, stopping: false, active };
  }

  current(): ChatTurn | null {
    return this.#turn?.active() ? { requestId: this.#turn.requestId, stopping: this.#turn.stopping } : null;
  }

  stop(expected: string | undefined, cancel: (requestId: string) => void): StopResult {
    const turn = this.current();
    if (!turn) return { status: "idle" };
    if (expected !== undefined && expected !== turn.requestId) return { error: "The requested turn is no longer running." };
    if (!turn.stopping) {
      this.#turn!.stopping = true;
      this.#stopped.add(turn.requestId);
      cancel(turn.requestId);
    }
    return { status: "stopping", requestId: turn.requestId };
  }

  /** Think persists aborted partials before this hook. Remove only that exact assistant row. */
  async finish(
    result: { requestId: string; status: string; message: { id: string } },
    remove: (id: string) => Promise<unknown>
  ): Promise<boolean> {
    const turn = this.#turn?.requestId === result.requestId ? this.#turn : null;
    const stopped = this.#stopped.has(result.requestId) || Boolean(turn && result.status === "aborted");
    if (stopped) await remove(result.message.id);
    this.#stopped.delete(result.requestId);
    if (this.#turn === turn) this.#turn = null;
    return stopped;
  }
}

export function stopRequestId(body: unknown): { requestId?: string } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object." };
  const value = (body as { requestId?: unknown }).requestId;
  if (value === undefined) return {};
  return typeof value === "string" && value.length > 0 && value.length <= 200
    ? { requestId: value }
    : { error: "requestId must be a nonempty string of at most 200 characters." };
}
