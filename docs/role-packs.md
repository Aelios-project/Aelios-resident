# Role packs and machine model requests

A role pack is one role card stored in the cloud for a resident. The settings
page calls these cards roles. A card has a name, work instructions, an optional
cloud thread model (`model`), and a separate optional machine helper model
(`machineModel`) with explicit family metadata (`family`). A pack does not select
a machine, helper, workspace or permissions.

Configure the card in task settings, or save it through
`POST /web/tasks/roles` (under `/r/<id>` for a named resident):

```json
{
  "name": "reviewer",
  "template": "Review the change without editing it. Report reproducible findings.",
  "model": "vendor/exact-cloud-model-id",
  "machineModel": "exact-helper-model-id",
  "family": "openai"
}
```

`model` is used by the resident's own threads and GitHub Actions. `machineModel`
is the exact id accepted by the machine's intended helper; it is sent on the
wire as `work.model`. These are independent: a gateway model id is never used as
a machine model fallback. The resident does not translate ids or invent a
default. An empty `machineModel` sends neither `work.model` nor `work.family`;
the helper keeps its own model selection.

Family describes the machine model and is chosen by the user, not guessed from
either model's spelling. It is a lowercase identifier of at most 40 letters,
digits or hyphens; examples are `anthropic`, `openai`, and `kiro-auto`. Existing
cards gain no machine model during migration. An older client that omits the
machine fields preserves their saved values, even when it changes `model`.
Changing `machineModel` without supplying a family clears the previous family.

Using a reviewer from a different provider or family than the author is advised,
not required. With one subscription or model, use the available resources and
state the actual reviewers and limitations in the report. Do not hard-code model
names or invent independent reviewers. This PR does not add a review orchestrator
or enforce a family comparison.

A machine job using a role, including a follow-up that keeps that role, takes a
snapshot of `machineModel` and `family` when dispatched. Later edits to the card
do not alter queued work. The thread page labels the choice as a requested model
next to the helper; it does not claim the helper honored the request.

Kiro always runs on `auto`, so the thread page omits the requested model when the
machine reports the Kiro helper. A supporting runner must drop a model sent to
a Kiro machine and return an `fyi` notice, which appears with the turn's notes.
Leave Kiro's machine model empty; a role can explicitly name `auto` with family
`kiro-auto`. An older runner ignores the new work fields. Runner support is
separate work; this change is confined to the resident.

See [the resident protocol](../PROTOCOL.md#jobmodel) for `job.model`, capability
negotiation and the exact wire fields.

## Verification

Run `npm run typecheck`, `node test/machine-job-model.mjs`,
`node test/task-roles.mjs`, `node test/machine.mjs`, `node test/web-ui.mjs`, and
`node test/cloud-tasks.mjs`. On a fresh local test Worker and mock server, run
`node test/run.mjs tasks-roles` to check that both machine fields survive the
actual HTTP save route and subsequent reads. Set `TEST_WORKER` to the local
Worker URL when port 8787 is already in use. These use synthetic data and no
paid helper.
