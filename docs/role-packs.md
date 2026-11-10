# Role packs and machine model requests

A role pack is one role card stored in the cloud for a resident. The existing
settings page calls these cards roles. Each card has a name, work instructions,
an optional exact model id (`model`), and optional explicit model family
(`family`). A pack does not select a machine, helper, workspace or permissions.

Configure the card in task settings, or save it through
`POST /web/tasks/roles` (under `/r/<id>` for a named resident):

```json
{
  "name": "reviewer",
  "template": "Review the change without editing it. Report reproducible findings.",
  "model": "vendor/exact-review-model-id",
  "family": "openai"
}
```

Use the exact id accepted by the intended helper. The resident does not translate
ids or invent a default. Family is a lowercase identifier of at most 40 letters,
digits or hyphens; examples are `anthropic`, `openai`, and `kiro-auto`. It is
metadata chosen by the user, not guessed from the model's spelling. A card with
no model sends neither `model` nor `family` to a machine. Existing cards migrate
without acquiring a model or family. Updating an existing model through an old
client preserves its family; changing the model without supplying a family
clears the previous family.

A reviewer must use a different family from the author. Configure an explicit
family for both roles and compare families before dispatching a review. A
different model id within the same family does not meet this requirement.
This PR documents that review policy; it does not introduce an author/reviewer
workflow or claim to enforce a family comparison without an author job.

A job using a role, including a follow-up that keeps that role, takes a snapshot
of its model and family when dispatched. Later edits to the card do not alter
queued work. The thread page labels the choice as a requested model next to the
helper; it does not claim the helper honored the request.

Kiro always runs on `auto`. A supporting runner must drop a model sent to a Kiro
machine and return an `fyi` notice, which appears with the turn's notes. A Kiro
role may explicitly name `auto` and family `kiro-auto`. An older runner ignores
the new work fields. Runner support is separate work; this change is confined
to the resident.

See [the resident protocol](../PROTOCOL.md#jobmodel) for `job.model`, capability
negotiation and the exact wire fields.

## Verification

Run `npm run typecheck`, `node test/machine-job-model.mjs`,
`node test/task-roles.mjs`, `node test/machine.mjs`, `node test/web-ui.mjs`, and
`node test/cloud-tasks.mjs`. These use synthetic data and no paid helper.
