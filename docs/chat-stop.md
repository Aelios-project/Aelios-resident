# Stop the current resident reply

The web and phone chat shows an accessible square stop button beside the composer while the resident has an active chat turn, including a turn currently running tools. Reloading the page reads the active turn from the server. Stopping is independent from stopping a machine thread.

## HTTP contract

Add **`POST /web/stop`** to the desktop plugin's existing Resident API allowlist. This PR does not change Aelios-desktop.

Use the existing web API authentication, for example `x-web-key`. The route also uses the existing Telegram Mini App authentication. Other residents use the standard `/r/<resident-id>/web/stop` prefix.

The body is a JSON object. To stop the current turn:

```json
{}
```

To stop only a turn observed by this client:

```json
{ "requestId": "the requestId from GET /web/messages" }
```

The phone page always sends the observed ID, so a delayed click cannot cancel a newer turn. `GET /web/messages` now includes `turn` in both full and `same: true` responses:

```json
{ "turn": { "requestId": "current-turn-id", "stopping": false } }
```

An idle chat returns `turn: null`.

Responses:

- `200 { "status": "stopping", "requestId": "current-turn-id" }`: cancellation was requested. Poll messages until `turn` is null; this response does not claim that cleanup has already finished.
- `200 { "status": "idle" }`: no current turn exists. Repeating stop is safe.
- `409 { "error": "The requested turn is no longer running." }`: a different turn is running; it was not stopped.
- `400 { "error": "..." }`: invalid JSON, a non-object body, or an invalid `requestId`.
- `401`: missing or invalid existing web authentication.

## Cleanup

The implementation calls the installed Think SDK's public `cancelChat(requestId)` API. Think persists partial assistant messages when a stream is aborted. The response hook removes that exact unfinished assistant row through the public session API, clears the draft and turn state, and skips reply delivery. The user message and earlier completed replies stay. A late hook for a stopped turn cannot clear a newer turn.

An aborted `/web/say` or regenerate request is treated as an intentional stop on the page, rather than as a failed message to retry. Queued user messages, independently running machine jobs, and completed tool side effects are outside the current reply's cancellation scope. The stop flag is process-local; this change does not add a durable cancellation workflow for a Worker restart during the stop request.

SDK references:

- [Request cancellation](https://developers.cloudflare.com/agents/agent-class/communication-channels/chat/chat-agents/)
- [Think response hooks](https://developers.cloudflare.com/agents/harnesses/think/lifecycle-hooks/)

## Validation

```sh
npm run typecheck
node test/chat-stop.mjs
node test/web-ui.mjs
```

For the real local Worker check, start this branch's fake upstream server and a fresh Worker using `wrangler.test.jsonc` on port 18811, then run:

```sh
NO_PROXY=127.0.0.1,localhost WORKER_URL=http://127.0.0.1:18811 node test/chat-stop-worker.mjs
```

The Worker check covers authentication and body validation, stop during a partial streamed reply, stale request IDs, no persisted partial or pending state after stopping, a subsequent successful reply, and stop during an actual delayed memory tool call. It uses synthetic data and no paid model or production deployment.
