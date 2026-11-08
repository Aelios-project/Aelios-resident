// The turns in flight between the resident and its boxes. A turn goes down a box's socket as one `turn` frame; the
// reply comes back as `line` frames and `end`, and leaves here as the NDJSON body the models read (kiro-box.ts,
// claude-code.ts), the same body the box used to answer over HTTP. Stopping the reader sends `cancel` down the socket.
// The sockets are the hub's (box-hub.ts); this keeps only the turns, so a test runs it with plain objects.

export type BoxSocket = { send(data: string): void };
type Turn = { boxId: string; socket: BoxSocket; controller: ReadableStreamDefaultController<Uint8Array> };

const encoder = new TextEncoder();
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const ndjson = (line: unknown) => encoder.encode(`${JSON.stringify(line)}\n`);

export class BoxTurns {
  readonly #turns = new Map<string, Turn>();

  get open(): number {
    return this.#turns.size;
  }

  /** Sends a turn to a box; the streamed NDJSON reply. Nothing but `plug` and `body` goes down. */
  start(boxId: string, socket: BoxSocket, plug: string, body: unknown): Response {
    const id = hex();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#turns.set(id, { boxId, socket, controller });
        try {
          socket.send(JSON.stringify({ t: "turn", id, plug, body }));
        } catch {
          this.#finish(id, "the box connection broke");
        }
      },
      cancel: () => {
        const turn = this.#turns.get(id);
        if (!turn) return;
        this.#turns.delete(id);
        try {
          turn.socket.send(JSON.stringify({ t: "cancel", id }));
        } catch {
          // The box is gone: nothing left to stop.
        }
      }
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  }

  /** A line of a turn, from the box that has it. A line for a turn this box does not have is answered with `cancel`. */
  line(boxId: string, id: string, line: Record<string, unknown>, socket: BoxSocket): void {
    const turn = this.#turns.get(id);
    if (!turn || turn.boxId !== boxId) return void socket.send(JSON.stringify({ t: "cancel", id }));
    try {
      turn.controller.enqueue(ndjson(line));
    } catch {
      this.#turns.delete(id);
    }
  }

  end(boxId: string, id: string): void {
    if (this.#turns.get(id)?.boxId === boxId) this.#finish(id);
  }

  /** The box's socket is gone (closed, revoked, broke): its turns end with the reason. */
  lost(boxId: string, why: string): void {
    for (const [id, turn] of [...this.#turns]) if (turn.boxId === boxId) this.#finish(id, why);
  }

  #finish(id: string, error?: string): void {
    const turn = this.#turns.get(id);
    if (!turn) return;
    this.#turns.delete(id);
    try {
      if (error) turn.controller.enqueue(ndjson({ error }));
      turn.controller.close();
    } catch {
      // The reader already went away.
    }
  }
}
