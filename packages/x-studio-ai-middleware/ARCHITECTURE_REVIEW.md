# Architecture / tech-debt review — `@mui/x-studio-ai-middleware`

Fresh, adversarial review of the current `src/` tree (not trusting prior review docs).
Baseline confirmed green before review: `tsc -p tsconfig.json` exits 0, and
`vitest --project "x-studio-ai-middleware*" --run` passes (17 files, 545 tests).

Scope: the untrusted-LLM-input security boundary — `handleAIChat`/`runAgenticLoop`,
`executeToolOnState`, `toolPolicy.ts`, `mcp.ts` + `mcp/*`, `chartRenderer.ts`,
`buildAISystemPrompt.ts`. Findings were traced through to the actual `@mui/x-studio-schema`
exports and the client caller in `@mui/x-studio`.

---

## Tier 1 — Correctness & Security

### 1.1 `get_dashboard_state` (and the `studio://dashboard/state` resource) dump the entire cross-thread AI chat history to the model / provider

**Files:**

- `src/executeToolOnState.ts:290` — `output: JSON.stringify({ doc: state.doc, dataSources })`
- `src/mcp/resources.ts:191` — `text: JSON.stringify({ doc: stateBox.current.doc, dataSources }, null, 2)`

**What's wrong:** Both the `get_dashboard_state` tool plan and the
`studio://dashboard/state` MCP resource echo `state.doc` **verbatim**. `StudioDoc`
includes the `ai?` partition (`packages/x-studio-schema/src/chatTypes.ts`):

```ts
interface StudioAIState {
  threads: StudioAIChatThread[];
  activeThreadId?: string;
}
interface StudioAIChatThread {
  id;
  name;
  createdAt;
  updatedAt?;
  messages: ChatMessage[];
}
```

`messages` is the **full message history of every thread**. So a single
`get_dashboard_state` call returns the complete conversation history of _all_ threads
(not just the active one) as tool output, which is then round-tripped back to the LLM
provider in the follow-up turn.

The code goes to great lengths to prevent exactly this class of leak for the sibling
partition: `projectDataSourceMetadata` (`executeToolOnState.ts:60`) strips `rows`/`adapter`
and caps `fieldDistinctValues`, with comments calling raw rows "a token bomb and an
exfiltration path that defeats `privateMode`" (`executeToolOnState.ts:283-284`). The
`doc.ai` partition — pure conversation content, unbounded in size — sails straight through
untouched. The `<dashboard_state>` system-prompt block deliberately never reads `doc.ai`
(`buildDashboardState` in `buildAISystemPrompt.ts:482-682` only reads
`dashboard`/`pages`/`widgets`/`filters`/`dataSources`/`session.mode`), so the tool
re-introduces data the prompt path intentionally withholds.

**This reaches the boundary in practice.** The client's `serializeDashboardState`
(`packages/x-studio/src/components/StudioChatPanel/sseUtils.ts:16-30`) strips only
`runtime.dataSources.rows`/`adapter`; it leaves `doc.ai` intact, and the request body
sends the whole state (`studioBackendAdapter.ts:268`). Per the schema docs, `doc.ai` is
persisted with the dashboard for "shareable dashboards with embedded AI context"
(`chatTypes.ts:31-33`), so in a loaded/shared-dashboard scenario one user's chat history
can be disclosed into another user's model session.

**Failure scenario:** A user has three chat threads (one about salaries, two unrelated).
On the active thread they type "what widgets exist?"; the model calls
`get_dashboard_state`. The tool output includes `doc.ai.threads[].messages` for all three
threads, so the salary-thread transcript is fed to the provider inside the current,
unrelated request. On MCP, any client that reads `studio://dashboard/state` gets the same
dump. Impact: (1) cross-conversation information disclosure the user never consented to;
(2) an unbounded token bomb (full histories) that can blow the request past token limits
or the `maxTokensPerRequest` budget on the very next turn.

**Suggested fix:** Redact `doc.ai` before emitting it (the model does not need chat
history — it already has the current thread as the message array). Emit `doc` with `ai`
omitted, or reduced to per-thread metadata (`{ id, name, updatedAt, messageCount }`).
Do it in one shared helper (see Tier 2, finding 2.1) so both surfaces are fixed at once,
and add a `get_dashboard_state` test asserting `parsed.doc.ai` is absent/reduced (the
existing contract test at `executeToolOnState.test.ts:134` only checks pages/widgets and
`dataSources` redaction, so this regression is currently untested).

---

## Tier 2 — Design smells

### 2.1 The `{ doc, dataSources }` projection is hand-duplicated across the two read surfaces (so finding 1.1 exists in two places)

**Files:** `src/executeToolOnState.ts:285-291` and `src/mcp/resources.ts:183-195`.

Both surfaces build the AI-safe dashboard snapshot with the same hand-copied loop
(`for … dataSources[id] = projectDataSourceMetadata(source)`) and then echo `state.doc`
verbatim. The only shared piece is `projectDataSourceMetadata`; the _doc_ half of the
contract is copy-pasted. This is precisely why the `doc.ai` leak (1.1) had to be present
in two files, and why a future addition of another sensitive `StudioDoc` sub-partition
would need to be remembered in both. The MCP resource's own comment (`resources.ts:180-182`)
claims it "mirrors the `get_dashboard_state` TOOL's output contract exactly" — which is
true today only by manual discipline, not by construction.

**Direction:** Extract a single `projectDocForAI(doc): { doc, dataSources }` (or
`projectStateForAI(state)`) helper that both the tool plan and the resource call, so the
doc-redaction rule (including the 1.1 fix) lives in exactly one place and cannot drift.
An `executeToolOnState` export already exists for `projectDataSourceMetadata`, so this is
a natural sibling.

---

## Tier 3 — Minor / cosmetic

### 3.1 `set_widget_width` reports the _unclamped_ column value as the result

**File:** `src/executeToolOnState.ts:574` — `output: JSON.stringify({ success: true, widgetId, columns })`.

`columns` here is the raw model-supplied value. The actual applied value is clamped to
6–24 by `clampSpan` in the `setWidgetColSpan` reducer
(`packages/x-studio-schema/src/applyMutation.ts:44-52`). So a call with `columns: 100`
returns `{ success: true, columns: 100 }` while the widget is actually set to 24 — the
model is told a value took effect that did not. Non-numeric/`NaN` inputs are likewise
reported verbatim (they clamp to `MIN_SPAN` internally). Report the clamped value (or note
the clamp) so the model's world-model matches state.

### 3.2 Numeric `richContext.fieldStats` values are interpolated into the prompt without the `sanitizeForPrompt` choke point

**File:** `src/buildAISystemPrompt.ts:749-752` — `min=${s.min}, max=${s.max}, mean=${s.mean} (n=${s.sampledRows})` and `${s.distinctCount} distinct (n=${s.sampledRows})`.

The `key` in each `fieldStats` entry is sanitized (`sanitizeForPrompt(key)`), but the
stat _values_ (`min`/`max`/`mean`/`distinctCount`/`sampledRows`) are interpolated raw.
They are typed `number` and are computed numerically client-side, so under the normal data
flow no string can reach here — this is **not** exploitable via poisoned data-source rows
(those flow through `serializeFieldForAI`/`describeSource`, which do sanitize). It is a
narrow defense-in-depth inconsistency with documented invariant 13 ("every state-derived
string in the prompt is sanitized"): a hand-crafted request body could put a `</dashboard_context>…`
string in these `number`-typed fields and it would land unescaped inside `<dashboard_context>`.
Since `richContext` is client-supplied, this is self-injection (the requester injecting
their own prompt), not the third-party-data threat the boundary defends — hence Tier 3,
not Tier 1. Coercing through `sanitizeForPrompt` (or an explicit `Number()`/`String()`
guard) would close the gap and keep invariant 13 literally true.

### 3.3 `get_field_values` silently caps `limit` at 200, which the tool schema doesn't state

**File:** `src/mcp/queryTools.ts:230` — `Math.min(fieldLimit ?? 50, 200)`.

The `get_field_values` schema (`mcp/toolMetadata.ts:203-207`) documents only "Default 50"
with no maximum, but the handler hard-caps at 200. A client asking for `limit: 1000` gets
200 rows with no indication the request was clamped. Harmless, but the schema description
should mention the 200 cap for honesty (mirrors how `query_data_source` documents its
`maxQueryRows` clamp behavior).

---

## Areas checked and found sound (not reported)

- **Policy chokepoint / purity invariant** (`toolPolicy.ts`): the execute-then-gate vs.
  args-only split is correctly enforced; `query_data_source` is `{ effect: 'external' }`
  with no `plan`, so it cannot enter the dry-run path, and both transports consult the
  policy before it runs. `Policy.all` strictest-wins ordering and the `mutationBudget`
  `mayMutate`/`proposed` gating are correct; `committedMutations` is incremented only at
  the real commit point on both transports.
- **Advertisement-is-not-authorization (T1-1 / T1-3)**: `dispatchToolCall`'s
  `advertisedToolNames` gate and `mcp.ts`'s `isToolAllowed`/`registeredToolNames` gate both
  run before any dispatch; `PRIVATE_MODE_EXCLUDED_TOOLS` is registry-derived and removes
  tools from the advertised set (not merely from the prompt), including `query_data_source`
  even when `data` is configured.
- **MCP resource-read authorization**: `studio://data/{id}` and `.../data-health` both go
  through `authorizeResourceDataAccess` (allowlist + args-only policy consult + approval
  bridge) mapped onto `query_data_source`; `studio://schema/{id}` and `.../system-prompt`
  serve no live query. `hidden` is consistently treated as a listing declutter flag, not
  an access boundary (documented).
- **SVG injection** (`chartRenderer.ts`): `width`/`height`/`colors` are validated at one
  choke point (`sanitizeInput`, strict hex + finite/bounded dimensions) before any renderer
  interpolates them into attribute positions; all text content passes through `esc()`
  (`<`/`>`/`&`/`"`), and every attribute uses double quotes so single-quote is inert.
  Numeric interpolations (`total`, tick values, `d.value`) are genuine numbers.
- **Prompt-injection escaping**: `sanitizeForPrompt` is applied to every state-derived
  string reaching a tagged region in `buildAISystemPrompt.ts` (titles, field
  ids/labels/descriptions, distinct values, filter values, skill name/mode, enrichment
  notes). Skill `promptFragment` is intentionally raw (it is authored instruction content,
  and skills are client-declared, i.e. the requester's own instructions — not third-party
  data).
- **Prototype pollution**: the reducer (`applyMutation.ts`) guards every untrusted-key
  bracket write with `isSafePatchKey`/`Object.hasOwn`; `createDefaultWidget` uses
  `Object.hasOwn` for the kind lookup.
- **`apply_bulk_update` per-batch tracking**: the running `currentChartTypes` map is
  updated after each accepted chart-type change, so later same-batch updates validate
  against the just-set type; removals are correctly scoped to the active page; deltas
  (not snapshots) are emitted so concurrent edits survive.
- **Approval race** (`toolDispatch.ts`): `waitForApproval` races callback/timeout/abort,
  guards duplicate `toolCallId` across concurrent requests (without deleting the incumbent
  entry), and always cleans up its own entry; `buildApprovalDisplayInput` substitutes the
  real entity title from state so the human approves against what is actually removed.
- **MCP mutation mutex**: the mutating branch runs inside the `mutationChain` critical
  section, so the snapshot→dry-run→policy→approval→commit sequence can't be clobbered by a
  concurrent commit during a long approval wait.
- **Registry-derived drift guards**: `DESTRUCTIVE_TOOLS`, `MCP_UNSUPPORTED_TOOLS`,
  `PRIVATE_MODE_EXCLUDED_TOOLS`, `TOOL_TITLES`/`TOOL_ANNOTATIONS`, and the
  `AssertMutuallyAssignable` check all trace to `STUDIO_AI_TOOL_REGISTRY`; they are in sync.

---

**Counts — Tier 1: 1, Tier 2: 1, Tier 3: 3**
