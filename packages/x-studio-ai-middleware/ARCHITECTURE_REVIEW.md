# Architecture Review — Iteration 9 (fresh ground-up pass)

Scope: every file in `packages/x-studio-ai-middleware/src/` (including all of `mcp/`), read in full
against the current working tree, plus the producer/consumer contract with
`packages/x-studio-schema/src/applyMutation.ts` where a finding spans both packages. Nothing was
assumed from prior rounds; every previously-fixed gate was re-derived from source.

**Summary: 0 Tier 1 findings, 6 Tier 2 findings** (one authorization-parity gap, one residual
lost-update, two value/robustness gaps, one low-severity injection-hygiene residual, one doc drift
introduced by the iteration-8 fix wording), plus a short list of non-actionable hardening notes.

The two surfaces the task mandated re-verification of:

- **Prompt-injection surface (invariant 13):** re-swept every place a DB-, state-, or LLM-sourced
  string reaches a prompt template, MCP prompt message, MCP resource/tool metadata, or SVG output —
  including the files never named in a prior fix (`mcp/utilityTools.ts`, `mcp/queryTools.ts`,
  `mcp/summarisePage.ts`, `mcp/toolMetadata.ts`, `mcp/helpers.ts`, `mcp/types.ts`,
  `widgetConfigMeta.ts`, `buildPageLayoutContext.ts`, `studioSkills.ts`, `agenticLoop/openaiWire.ts`,
  `parseSSE.ts`). **I did not find a sixth full instance of the prior class** (an unsanitized
  state-derived value in a trusted instruction/metadata position). All five previously-fixed entry
  points are still correctly routed through `sanitizeForPrompt`. Two _marginal_ residuals exist and
  are reported below as T2-5 (a `prompts/get` error message that interpolates every configured
  source id raw) and hardening note H-1 (`buildAISystemPrompt`'s `availableDataTools` parameter is
  interpolated unsanitized, though every current caller passes hardcoded constants). Neither is a
  trusted-position injection of the severity of instances 1–5, and I am deliberately not inflating
  them to keep the streak alive — but per the invariant's own definition ("MCP tool/resource/prompt
  metadata a client places into its own model's context"), T2-5 is in-scope text and should be
  closed. So: the surface is closed _as far as this sweep can see_, with those two enumerated
  residuals; invariant 13's "not a standing guarantee" wording remains the right posture.
- **Resource-authorization surface:** the four gated URIs (`studio://dashboard/state`,
  `studio://dashboard/system-prompt`, `studio://dashboard/data-health`, `studio://data/{sourceId}`)
  are airtight — gates run before any payload is built, `sourceId` is threaded into the
  `studio://data/` consult, the `contextEnricher` enrichment passes the data gate, and denial
  reasons are clean throws. **It is NOT fully closed**: `studio://schema/{sourceId}` bypasses the
  state gate while serving row-derived `fieldDistinctValues` — see T2-1. The documented "ungated by
  design" rationale mischaracterizes that payload.

What I explicitly re-verified and found sound (no findings):

- `executeToolOnState.ts` multi-tool batch state threading: `currentState` is threaded through
  every tool call within a turn and across turns in `agenticLoop.ts`; `apply_bulk_update`'s running
  `currentChartTypes` map, `addedWidgetKinds`, `liveWidgetIds`, and
  `activePageWidgetIdsAfterBatch` all stay current across the batch; `set_widget_width` reads back
  the reducer-applied value; the reducer's `setWidgetColSpan` derives row membership from the
  _receiver's_ current state, not the wire snapshot.
- Chat T1-1 advertised-name gate, privateMode exclusion (including `query_data_source` even with
  `data` configured), skill/built-in name-collision dropping, parse-failure-before-execution,
  approval race (timeout/abort/duplicate-id/cleanup), `approvalFallback: 'deny'` default.
- MCP `tools/call`: `isToolAllowed` runs before _any_ dispatch; the mutating branch runs inside the
  per-session `mutationChain` mutex with the snapshot captured inside the critical section;
  `commitMutation` reports success before the `onStateChange` persistence hook and swallows hook
  failures; read-only dispatch-table tools pass the args-only consult + approval bridge.
- Policy chokepoint: execute-then-gate purity (the `PureToolImpl`/`ExternalToolImpl` split is
  intact; `query_data_source` remains unreachable through `executeToolOnState`), `Policy.all`
  strictest-wins with deny short-circuit, mutation-budget-before-host-policy on both transports,
  `committedMutations` incremented only at commit points.
- `projectStateForAI` is the single redaction home for both `get_dashboard_state` and
  `studio://dashboard/state`; `doc.ai` transcripts and `rows`/`adapter` are stripped on both.
- Query clamps: `query_data_source` `limit`/`offset` and `get_field_values` `limit` are clamped on
  the shared factory used by both transports (see T2-6 for a doc-only drift in how the negative
  case is described).
- `chartRenderer.ts`: all six renderers guard empty/all-non-positive data; text/value/color/
  dimension coercion at the `sanitizeInput` choke point holds; `esc()` is total over `unknown`;
  `renderPie` has no division-by-zero path (positive-only `total`, guarded legend percentages).
- Prototype-key lookups: `resolveSource` (`!source || !source.tableName`), `studio://data/`, and
  `summarise_page` (`source?.tableName`) all fail closed on e.g. `constructor` — except the one
  site in T2-4.

---

## Tier 2 findings

### T2-1 — `studio://schema/{sourceId}` bypasses the state-access gate while serving row-derived distinct values

**Where:** `src/mcp/resources.ts:361-402` (the `studio://schema/` branch has no
`authorizeStateAccess` call); gate wiring in `src/mcp.ts:585-610`; documented as by-design in
`ARCHITECTURE.md` ("`studio://schema/{sourceId}` serves only static field metadata (no live query)
and is ungated").

**What's wrong:** Finding 2.1 (iteration 8) established the principle that a resource read exposing
the same payload as a tool must pass that tool's authorization gate, and wired
`studio://dashboard/state` / `system-prompt` through `authorizeResourceStateAccess`
(`isToolAllowed('get_dashboard_state')` + args-only policy consult). But
`studio://schema/{sourceId}` serves a **per-source slice of the very same
`projectStateForAI` payload**: `id`, `label`, `tableName`, `aiDescription`, full field definitions,
**`sampleValues: source.fieldDistinctValues[f.id].slice(0, 8)`** (resources.ts:389-391), and the
`serializeFieldForAI` string (which embeds up to 8 distinct values per field again). The "static
field metadata" rationale is wrong for `fieldDistinctValues`: those are row-derived data values —
the exact category `MAX_DISTINCT_VALUES_IN_STATE_OUTPUT` caps and `privateModeExcluded` treats as
sensitive on the chat side.

**Concrete failure scenario:** a host locks the session down with `allowedTools: []` (documented as
disabling _every_ tool, including `get_dashboard_state`) or a `toolPolicy` that denies
`get_dashboard_state`. The `studio://dashboard/state` read is now correctly refused — but the
client enumerates `resources/list` (also ungated; it exposes every non-hidden source's label/id)
and reads `studio://schema/<id>` for each source, recovering the full schema catalogue _plus up to
8 real data values per field per source_. The host's deny is silently ineffective for a meaningful
subset of the gated payload.

**Fix direction:** run the existing `authorizeStateAccess()` gate at the top of the
`studio://schema/` branch (one-line parity with the two sibling branches). If the ungated-schema
convenience is worth keeping, a narrower fix is to serve the _structural_ fields ungated but strip
`sampleValues` and the distinct-value section of `serialized` unless the gate passes — and either
way, correct the ARCHITECTURE.md sentence that calls this payload "static field metadata".

### T2-2 — colSpans-only `apply_bulk_update` still ships the full turn-start span snapshot (residual of the T2-4/2.3 lost-update class)

**Where:** producer `src/executeToolOnState.ts:996` (`const colSpans = {
...(activePage.widgetColSpans ?? {}) }` — a turn-start snapshot), `:1265-1267` (batch entries
merged into that snapshot), `:1298-1308` (`colSpansOnly` → `layoutFields = { widgetColSpans:
colSpans }` — the _whole_ map, not the batch's entries). Consumer
`packages/x-studio-schema/src/applyMutation.ts:1259-1311` — in the spans-only branch
(`widgetRows === undefined`) the reducer reconciles rows against the page's existing rows (good)
but then **wholesale-replaces** `widgetColSpans` with `enforceLayoutColSpans([], sanitizedRows,
clampedSpans)` built from the wire map alone.

**What's wrong:** Iterations 7–8 closed this lost-update class twice: updates-only batches omit
both layout fields (T2-4), and colSpans-only batches omit `widgetRows` so a concurrent drag-reorder
survives (finding 2.3). But the third field of the same snapshot is still shipped: the
`widgetColSpans` map sent for a colSpans-only batch contains the turn-start span of **every**
widget on the page, and the reducer replaces the receiving side's map with it.

**Concrete failure scenario:** the model runs `apply_bulk_update({ colSpans: { "widget-A": 8 } })`
(the schema explicitly invites this: "Only include widgets whose width should change"). While the
turn is running, the user drag-resizes widget B from 12 → 18 columns in the browser. The
`state-mutation` event arrives carrying `widgetColSpans: { A: 8, B: 12, … }` (B's _turn-start_
value); `StudioController.applyExternalMutation` runs the same reducer, which replaces the page's
spans — B silently snaps back to 12. Exactly the lost-update shape 2.3 fixed for `widgetRows`, one
field over.

**Fix direction:** in the reducer's spans-only branch (`widgetRows === undefined`), _merge_ the
wire spans onto the page's current spans before clamping/enforcing
(`{ ...(page.widgetColSpans ?? {}), ...clampedSpans }`) instead of replacing. This is backward
compatible with the current full-snapshot producer (merge of a superset ≡ replace for the keys it
carries, and preserves any client-side span the snapshot doesn't know about — strictly better), and
it then allows the producer to ship only the batch-changed entries. Bulk `colSpans` cannot clear a
span (entries must be numbers 6–24), so merge semantics lose nothing.

### T2-3 — `set_widget_forecast` stores `showConfidenceBands` unvalidated and treats a truthy non-boolean `enabled` as `true` (finding-3.2 value-shape class)

**Where:** `src/executeToolOnState.ts:1376-1467`; specifically `:1438-1445` — `enabled ? { …,
...(showConfidenceBands != null ? { showConfidenceBands } : {}) } : { enabled: false }`.

**What's wrong:** the same tool that carefully coerces `periods` (added for finding 3.2, because
"the tool schema declares it a number, but the argument is untrusted") spreads
`showConfidenceBands` into the stored forecast config **verbatim** — a model-supplied
`showConfidenceBands: "no"` stores a string in a `boolean`-typed field (structurally-broken config,
truthy at render time, and the exact stored-value shape `SCALAR_CONFIG_VALUE_TYPES` exists to keep
out of state — nested `forecast` keys are simply outside that table's scope). Separately, `enabled`
is only truthiness-checked: `enabled: "false"` (a classic LLM string-boolean slip) is truthy, so a
call _intended to disable_ the forecast **enables** it, and the tool reports
`{ success: true, forecast: { enabled: true, … } }`.

**Concrete failure scenario:** model emits `set_widget_forecast({ widgetId, enabled: "false" })` to
turn a forecast off; the forecast stays on (now with `method: 'linear'` re-stamped), and the model
is told it succeeded. Or `showConfidenceBands: "maybe"` lands a string in persisted widget config
that every consumer types as `boolean | undefined`.

**Fix direction:** mirror the `periods` handling — reject non-boolean `enabled` /
`showConfidenceBands` with an actionable error (`typeof x !== 'boolean'`), or at minimum coerce
`showConfidenceBands` with `Boolean()` and hard-error on non-boolean `enabled` (silent coercion of
`"false"` → `true` is the dangerous direction).

### T2-4 — `studio://schema/<prototype-key>` throws a raw `TypeError` instead of "Unknown data source"

**Where:** `src/mcp/resources.ts:363-370` — `const source =
stateBox.current.runtime.dataSources[sourceId]; if (!source) { throw … }` followed by
`source.fields.filter(...)` at `:370`.

**What's wrong:** `dataSources` is a plain object, so `dataSources['constructor']` (or any
`Object.prototype` member name in the URI) resolves to a truthy non-source value; the `!source`
guard passes and `source.fields.filter` throws `Cannot read properties of undefined (reading
'filter')`, surfaced as an opaque protocol error. Every sibling lookup in the package already
handles this: `resolveSource` checks `!source || !source.tableName`
(`mcp/queryTools.ts:54-65`), the `studio://data/` branch checks both (`resources.ts:423`), and
`summarisePage.ts` uses `source?.tableName`. This is the one lookup that doesn't, and the schema
package's reducer conventions (`Object.hasOwn` guards throughout `applyMutation.ts`) make the
expected pattern explicit.

**Concrete failure scenario:** an MCP client reads `studio://schema/constructor` (typo, fuzzing, or
a model hallucinating an id) and gets an internal `TypeError` string instead of the actionable
"Unknown data source … Check studio://dashboard/state" error every other path returns.

**Fix direction:** use `Object.hasOwn(stateBox.current.runtime.dataSources, sourceId)` (or check
`!source?.fields`) before dereferencing — one line, matching the established convention.

### T2-5 — `prompts/get` unknown-`sourceId` error interpolates every configured source id raw (injection-hygiene residual, low severity)

**Where:** `src/mcp/prompts.ts:61-66` — ``throw new Error(`Unknown sourceId: "${requestedId}".
Available: ${allSources.map((s) => s.id).join(', ')}.`)``.

**What's wrong:** this is the only remaining site in the package where **state-derived** strings
(every non-hidden source's `id`) are interpolated into an MCP-facing _text_ surface without
`sanitizeForPrompt` — in the very file whose iteration-7 fix sanitized `s.id` in the example
blocks, on the grounds that `prompts/get` output lands in a client's LLM conversation. MCP error
messages routinely get fed back to the calling model by agent clients. Severity is genuinely low:
ids also appear raw in `uri` fields and `completion/complete` values under the package's explicit
"addressable identifier" carve-out, and this list is functionally an identifier list the client
uses to retry the call. But it is free-form error prose, not a parsed identifier field, so under
invariant 13's own definition it should go through the choke point rather than rely on the
carve-out by analogy.

**Concrete failure scenario:** a host registers a source whose id embeds markup/instruction text
(ids are host-injected, so this needs a sloppy or tenant-influenced host — hence low severity); any
`prompts/get` call with a wrong `sourceId` then echoes that raw text into the client's error
handling, which many MCP clients splice into the model conversation.

**Fix direction:** `allSources.map((s) => sanitizeForPrompt(s.id)).join(', ')` (and
`sanitizeForPrompt(requestedId)` for symmetry with how `resources/list` treats the same values) —
two calls, no behavior change for well-formed ids.

### T2-6 — ARCHITECTURE.md misdescribes the iteration-8 limit clamps: a _negative_ limit floors to 1, it does not "fall back to the default"

**Where:** `ARCHITECTURE.md` module-map row for `mcp/queryTools.ts` (two claims: `get_field_values`
"a non-numeric/zero/negative/`NaN` value falling back to the default of 50"; `query_data_source`
"a non-numeric/zero/negative/`NaN` value — e.g. a model-supplied `"all"` or `-1` — falls back to
`maxQueryRows`"). Actual code: `src/mcp/queryTools.ts:105-106` and `:254-255` —
`Math.min(Math.max(1, truncated || fallback), cap)`.

**What's wrong:** `truncated || fallback` only substitutes the default for **falsy** truncations
(`0`, `NaN`); a negative value like `-1` is truthy, so it reaches `Math.max(1, -1)` and clamps to
**1**, not to 50/`maxQueryRows`. The code comments in `queryTools.ts` describe this correctly
("truncate, floor at 1, and fall back to the default on a falsy/NaN truncated value");
ARCHITECTURE.md's summary — written in the same iteration-8 round as the fix — folds "negative"
into the fallback set, which is exactly the kind of newly-introduced inconsistency this pass was
asked to catch. Behavior itself is defensible (a floor of 1 is safe), but the doc now overstates
what the model gets back: `limit: -1` returns one row, not the default page.

**Fix direction:** doc-only — correct both sentences to "zero/`NaN`/non-numeric falls back to the
default; a negative value is floored to 1". Alternatively (behavioral option) treat `truncated < 1`
as the fallback case in both clamps so docs and code converge on the friendlier semantics; if so,
do it in both clamps at once, since their symmetry was the point of finding 2.1.

---

## Hardening notes (not counted as findings)

- **H-1** — `buildAISystemPrompt.ts:900-903`: the `availableDataTools` option is interpolated into
  the prompt without `sanitizeForPrompt`. Every current caller passes hardcoded literals
  (`mcp/resources.ts:262-264`), so this is not reachable with untrusted data today, but it is an
  unsanitized parameter on the choke-point file itself — cheap to route through
  `sanitizeForPrompt` now, before a future caller passes something dynamic.
- **H-2** — `mcp/helpers.ts:52-59` `withTimeout` never clears its timer on the win path; each
  `summarise_page` widget query keeps a 15 s timer alive after settling. Cosmetic (delays process
  exit in short-lived contexts, no unbounded growth).
- **H-3** — `mcp/queryTools.ts` `describe_data_source` fires 1 + N concurrent unbounded,
  un-timed-out queries (N = numeric fields); `studio://dashboard/data-health` fires one COUNT per
  source, also without `withTimeout`. `summarise_page` bounds its queries; these two don't. Host
  `queryDataSource` implementations are expected to defend themselves, but wrapping these in the
  existing `withTimeout` would be consistent.
- **H-4** — `apply_bulk_update` additions: `addedTitleToId[widget.title] = widget.id` silently
  last-wins on duplicate titles. The system prompt warns the model against duplicates, and layout
  refs then bind to the later widget; a `skipped` entry on duplicate titles would make the failure
  observable instead of silent.

## Tier 1

None found this round. Specifically re-checked and _not_ reproducible: advertisement-vs-dispatch
bypasses on either transport, any ungated live-query path (the schema-resource gap in T2-1 exposes
capped state-resident values, not live queries), policy-bypass via the dispatch table, dry-run side
effects, cross-request approval misrouting, SVG attribute injection, and prototype-pollution writes
(reducer-side `isSafeKey`/`Object.hasOwn` guards are intact; T2-4 is a read-side crash, not a
write).
