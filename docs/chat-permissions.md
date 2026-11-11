# Pending permissions in chat

The main chat shows live machine permission requests as compact cards with the thread title, request title, redacted command, and Allow / Deny buttons. Cards are a projection of the Waiting list, not persisted conversation messages.

`GET /web/messages` includes a `permissions` array on both full and incremental responses. Each entry is the same `WaitingItem` with `kind: "permission"` and a `perm` identifier that `/web/waiting` returns. Polling updates this projection even when the conversation itself has not changed. The page clears it when changing residents or logging out.

Both views answer through the existing authenticated endpoint:

```http
POST /web/waiting/permission
Content-Type: application/json

{"id":"p_0123456789","allow":true}
```

Use `allow: false` to deny. Answering removes the pending item from both views; the runner still receives the answer on its next poll. Closing the request on the desktop, ending the work, or expiration removes the card on the next chat poll. The model cannot approve requests.

A successful machine permission report now triggers the existing Waiting push path. Existing deduplication sends each request once when notifications are enabled, with the `permission` tag. Push delivery remains subject to the existing subscription, provider, and notification settings. No conversation turn is needed to send this notification.

## Verification

```sh
npm run typecheck
node test/chat-permissions.mjs
node test/machine-perms.mjs
node test/waiting.mjs
node test/web-ui.mjs
```

The focused regression executes the real permission-report orchestration with SQLite-backed stores and verifies the push trigger, repeat-report deduplication, shared decisions, desktop closure, incremental page polling, and both chat actions.

For local HTTP integration, start `test/mock-server.mjs` and a fresh Worker with `wrangler.test.jsonc`, then run:

```sh
NO_PROXY=127.0.0.1,localhost WORKER_URL=http://127.0.0.1:18813 node test/chat-permissions-worker.mjs
```

The HTTP test pairs a synthetic runner and checks held requests, both answers, runner polling, and desktop closure against real Worker routes. It does not test browser push delivery or a physical phone.
