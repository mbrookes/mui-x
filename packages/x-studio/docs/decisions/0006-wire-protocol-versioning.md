# 0006 — Versioning the two host wires

**Status:** Accepted, 2026-08-07. Implemented.

## Context

Studio's whole integration story is "run these two handlers in your backend":

- `handleAIChat(body, opts)` from `@mui/x-studio-ai-middleware`
- `handleBatchQuery(body, opts)` from `@mui/x-studio-data-middleware`

The host owns the HTTP layer, the deployment, and the upgrade schedule for each side. So a host
upgrading `@mui/x-studio` without upgrading its server — or the reverse — is the **normal** case for
this shape of library, not an edge case.

The wire types are shared through `@mui/x-studio-schema`, which was the right fix for a different
problem (two hand-maintained copies of one shape, held equal by comment). But **shared types are
not a versioned contract.** Both sides compile against the schema package; each compiles against
whichever copy it installed, and nothing at runtime compared the two.

The consequence was a mismatch presenting as something else entirely:

- On the data wire, as a field-level validation failure — "expected an object with a widgets array"
  — which reads as a malformed payload.
- On the AI wire, as a tool call rejected for an argument the server had never heard of, which
  reads as a model error.

Both send the host to debug a field that was never the problem, rather than the half-finished
deployment that was.

## Options

1. **Leave it.** Nothing is broken today, and there are no external adopters. The cost rises
   sharply at the first one, because that is the point at which the two sides genuinely do version
   independently and the person debugging is not the person who shipped both halves.
2. **Version the packages and compare package versions.** Rejected: the package version changes on
   every release, including releases that do not touch the wire, so the check would fire constantly
   and be disabled within a week.
3. **A protocol version on each envelope, with a compatibility rule.** One integer per wire that
   changes only when the wire changes.

## Decision

Option 3. `packages/x-studio-schema/src/wireProtocol.ts` owns it.

**Two counters, not one.** `STUDIO_AI_WIRE_VERSION` and `STUDIO_DATA_WIRE_VERSION` are separate,
because the two wires change independently and are consumed by different servers a host may upgrade
at different times. One shared counter would force a bump on the AI wire for a change to the SQL
protocol — and a version number that changes for reasons unrelated to you is a version number
people learn to ignore.

**The rule is a supported range, not equality.** Each wire declares a CURRENT version (what this
build sends) and a MIN_SUPPORTED (the oldest a server built from this source accepts). A server
accepts `MIN_SUPPORTED <= received <= CURRENT`. Today both wires sit at 1 with MIN_SUPPORTED equal
to CURRENT; the range exists so an additive change can widen compatibility **deliberately** (bump
CURRENT, leave MIN_SUPPORTED) rather than by default.

**Newer-than-server is refused, not accepted.** This is the case a permissive rule gets wrong. A
newer client may send a field this server drops silently, so the dashboard renders numbers computed
without it — a wrong answer rather than an error. Refusing surfaces the real problem.

**`protocolVersion` is required in the type, not optional.** The compiler then finds every
construction site, which is what guarantees the real client stamps it; a test fixture forced to
declare a version is correct, because a request without one would be refused in production.

**Where in validation the check runs — after the frame, before the fields.** Both handlers do it in
the same position, and both directions were chosen against a concrete failure:

- **After the "is this a request body at all" check**, because an absent or non-object body is best
  diagnosed as exactly that. Version-first told a host with a broken route handler that their
  _client_ was too old, sending them to upgrade a package that was never the problem. Nothing is
  lost, because a version skew cannot produce a shapeless body.
- **Before every field check**, because a skew _can_ fail one. A client one release ahead still
  sends `{ pageId, widgets: [...] }`, so the frame survives — but "malformed widget descriptor at
  widgets[3]" is the wrong diagnosis for a stale deployment. Checking here catches the skew while
  it still looks like a skew.

**Failure shape differs by wire, message does not.** `handleBatchQuery` throws (it answers with a
rejected HTTP request); `handleAIChat` emits an SSE `error` event (its response has already begun as
a stream). Both build the failure from the same `checkStudioWireVersion` message, so the two wires
cannot drift in what they tell a host, and each names the package to upgrade and the versions on
both sides.

**`createSimpleAdapter` deliberately does not stamp one.** It POSTs a bare `StudioQueryDescriptor`
to a host that speaks the descriptor natively, so its wire is the host's own protocol — a Studio
version number would be meaningless on it. Only `createBatchingAdapter`, which talks to
`x-studio-data-middleware`, stamps the data wire.

## Consequences

**What it makes cheap.** A client/server skew is now a refused handshake naming both versions and
the package to upgrade, at the first thing either handler looks at. Adding a field to either wire
now has an obvious protocol step attached to it.

**What it costs.** A required field on both envelopes, so every construction site declares one —
about 180 in tests and fixtures, all found by the compiler. A discipline cost too: bumping the
number is not automatic, and a wire change shipped without a bump leaves the check silently
useless. `wireProtocol.test.ts` guards the one mechanical failure it can (MIN_SUPPORTED above
CURRENT, which would make a server refuse its own client); the rest is a review question.

**What it forecloses.** Nothing. The range rule leaves room for additive evolution, and neither
number has any meaning outside these two handlers.

**Reversal cost.** Low — the field could be made optional and the check dropped. It will not get
harder, which is the one respect in which this differs from every other decision in this log.

Closes finding A6 of [`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md).
