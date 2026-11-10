# Resident runner protocol: `aelios-runner/1`

The resident implements the cloud side in `src/machine.ts`. The runner lives in
[Aelios-desktop](https://github.com/Aelios-project/Aelios-desktop/blob/main/packages/runner/PROTOCOL.md).
This document records resident extensions. It does not change the runner.

## Capability negotiation

`POST /runner/v1/heartbeat` (under `/r/<id>` for a named resident) accepts the
runner's bearer token and returns:

```json
{
  "ok": true,
  "protocol": "aelios-runner/1",
  "accepts": ["heartbeat.engine", "receipt.ahead", "reason.refused", "reason.token_limit", "reason.no_result"],
  "limits": { "summary": 4000 }
}
```

The runner uses a new field or reason only when its capability name appears in
`accepts`. A response without `accepts` advertises no extensions. The list is
additive; clients must not require an exact match or reject unfamiliar names.
An optional heartbeat `engine` is a 1–40 character name using ASCII letters,
digits and `@._+-`. With `plugin`, it replaces both stored values; without
`plugin`, neither changes. Omitting `engine` while sending `plugin` clears it.

## Work and models

Poll returns `{ "work": null }` or a work object with `workId`, `token`, `thread`,
`kind`, `title` and, except for cancellation, `text`. Work kinds are `job`, `mail`,
`say` and `cancel`. The same claim key returns the same work. The machine alone
chooses its helper, workspace and permission tier.

### `job.model`

When `accepts` contains `job.model`, a runner may use optional top-level `model`
and `family` fields on non-cancellation work. `model` is the exact id configured
on the role card. `family` is optional explicit metadata such as `anthropic`,
`openai` or `kiro-auto`. Neither is inferred. Both are absent when the role has
no model, even if a family is configured. Old runners ignore these fields.

The resident freezes this selection when work is enqueued, including follow-ups
that use the role. Editing or deleting the role later does not change retained
work or claim replay. The thread page shows the most recent non-cancellation
work's requested model beside the machine's current helper and engine. It is a
request, not confirmation of the model actually used.

Kiro always runs on `auto`. A runner supporting `job.model` must drop a model
request on a Kiro machine and send an `fyi` notice in its final receipt. The
resident preserves that notice as the turn's note. This PR does not implement
that behavior in the separate runner repository.

## Receipts and asks

Receipts use `<workId>:<type>` as their id. Identical replay succeeds as a
duplicate; changed content under that id returns 409. A final receipt has a
status (`done`, `failed`, `needs_you`, `cancelled`) and a nonempty summary of at
most 4000 UTF-16 code units. `needs_you` requires an `ask` with `key`, `question`,
and optional `options` and `recommend`. `resolve` clears earlier ask keys.

`ahead` is allowed only on queued receipts, as an integer from 1 through 99.
Failed finals may use the advertised reasons `refused`, `token_limit` and
`no_result`. These are failure reports that the user opens, not questions.
Unknown top-level receipt fields and invalid field values return 400.

### `ask.kind`

A runner sends the optional nested `ask.kind` only after the heartbeat's
`accepts` contains `ask.kind`. Its only values are `permission` (waiting for
approval) and `question` (waiting for an answer). An absent kind keeps the
original generic waiting behavior. Invalid values, including `problem`, null,
an empty string, numbers and objects, return 400 `INVALID_RECEIPT` before any
ask or receipt is stored. Kind participates in the receipt replay fingerprint.

```json
{
  "type": "final",
  "status": "needs_you",
  "ask": { "key": "decision", "question": "Continue?", "kind": "permission" }
}
```

The example omits the normal receipt id, work id, token and summary for brevity.
The resident retains kind on unresolved asks and returns it as `asks[].kind`
on the thread page. Waiting items keep `kind: "ask"` and carry this subtype in
`askKind`; the page labels these as "等你批准" (waiting for approval) or "等你回答"
(waiting for an answer). Older rows and senders without kind retain their original labels.
A receipt permission ask is not a live `/permission` handle: it never acquires
an Allow/Deny handle or grants a tool permission by itself. Existing reply,
resolve and ask expiration behavior is unchanged.

A helper that has stopped because of refusal, a token limit or no result sends
a failed final with the appropriate advertised reason, not a `problem` ask.

Verification: `npm run typecheck`, `node test/machine-ask-kind.mjs`,
`node test/machine.mjs`, `node test/waiting.mjs`, `node test/machine-perms.mjs`,
and `node test/web-ui.mjs`.
