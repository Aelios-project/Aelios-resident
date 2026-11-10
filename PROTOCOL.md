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
