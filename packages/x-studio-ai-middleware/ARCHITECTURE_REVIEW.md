# Architecture Review — `@mui/x-studio-ai-middleware` (iteration 3)

**Scope:** Fresh, adversarial re-read of every file under `packages/x-studio-ai-middleware/src/`,
cross-file, from scratch. Focus on the untrusted-LLM-input security boundary (chat tool execution,
MCP resources/tools, prompt construction): privilege escalation, cross-thread/session/tenant leakage,
policy-chokepoint bypass, prompt injection — plus plain correctness.

**Baseline (verified in this worktree):**

- `tsc -p tsconfig.json --noEmit` → **clean (exit 0)**. (Requires the package-local
  `node_modules/@mui/*` symlinks, which resolve `@mui/x-studio-schema` etc.; the repo-root
  `node_modules` is only partially materialised in this environment, so `pnpm` reports
  `ERR_PNPM_UNSUPPORTED_ENGINE` / "already up to date" — an environment artifact, not a code issue.)
- Unit tests: **541 passed** across all 16 `src/**/*.test.ts` files. The documented
  `pnpm test:unit --project "x-studio-ai-middleware*"` command cannot run here because the shared
  `test/setupVitest.ts` imports `react-transition-group`, which is absent from this environment's
  `node_modules` (unrelated to this package). Ran instead via a local vitest config that includes the
  same 16 test files with `environment: node` and no shared setup — all green.
- MCP integration tests (`vitest.config.node.mts`, `src/__tests__/mcp.integration.test.ts`):
  **12 passed**.

## Summary

The package is in good shape. The two prior review rounds visibly hardened the core security
invariants, and I could not break them: the execute-then-gate policy chokepoint, the `advertisedToolNames`
dispatch-time gate (T1‑1), the private-mode tool exclusion (T1‑2), the built-in/skill name-collision
guard, the read-surface redaction (`projectStateForAI` strips `rows`/`adapter` and reduces `doc.ai`
transcripts to metadata), the human-in-the-loop approval race (dedupe + timeout + abort + always-delete),
and the mutation-budget combinator all hold up under adversarial reading and empirical probing.

**No actionable Tier 1 (correctness/security) findings.** I list below exactly what I probed and why
each attack fails.

**Two Tier 2 findings:** (1) `add_widget_filter` is the one entity-targeting mutating tool that does
_not_ validate its target exists, so it commits a dangling widget-scoped filter and reports `success`
— a data-integrity + model-misleading inconsistency with every sibling tool. (2) A residual SVG
markup-injection path in `chartRenderer.renderDonut`: the donut's centre `total` label is the only
model-influenced value interpolated into SVG **text content** without `esc()`, and a string-typed
`value` reaches it verbatim (defense-in-depth gap that the `ARCHITECTURE.md` "one choke point" claim
glosses over).

A few Tier 3 nits. Details and the deliberate-tradeoff notes follow.

---

## Tier 1 — Correctness & Security

**None found actionable.** This is not for lack of trying. The concrete escalation/leak/bypass
attempts I worked through, and why each is already closed:

- **Injected call to an unadvertised tool** (e.g. `remove_page` in a read-only assistant, or
  `query_data_source`/`get_dashboard_state` in `privateMode`). Blocked at _dispatch_ time by the
  `advertisedToolNames` gate in `agenticLoop/toolDispatch.ts:291-293`, not merely at advertisement
  time. `PRIVATE_MODE_EXCLUDED_TOOLS` (`agenticLoop.ts:282-286`) removes the state-reading tools from
  the advertised set in private mode, and it is derived from the schema registry's `privateModeExcluded`
  fact rather than hand-maintained, so it can't drift. Verified the excluded set matches
  `aiToolRegistry.ts` (`get_dashboard_state`, `list_pages`, `summarise_page`, `query_data_source`).

- **A body-declared skill (or host `skillHandlers` entry) shadowing a destructive built-in**
  (e.g. a skill literally named `remove_page` to skip the approval pause, or one named
  `query_data_source` to reach the client handler). Blocked by the `collidesWithBuiltIn` filter in
  `agenticLoop.ts:247-251`, applied to _both_ `skills` and `skillHandlers` _before_ the advertised
  list / prompt / dispatch context are built. Confirmed the dispatch order in `dispatchToolCall`
  cannot route a built-in name to a skill because the colliding skill is already gone.

- **Committing a mutation past the budget.** Every mutating path threads through
  `Policy.all(mutationBudget, hostPolicy)`: built-in mutating tools carry `proposed` (execute-then-gate),
  and mutating-capable server-tool skills are flagged `mayMutate` on the args-only path — both are
  gated by `Policy.mutationBudget` (`toolPolicy.ts:307-326`) before commit. `committedMutations` is
  incremented only at the actual commit point (`toolDispatch.ts:330,453,465`; `mcp.ts:318`), never on
  a denied/timed-out/aborted approval.

- **Cross-request approval misrouting** via a shared module-level `approvalPending` map keyed by bare
  `toolCallId`. `waitForApproval` (`toolDispatch.ts:44-51`) refuses a duplicate id (resolves
  not-approved without touching the incumbent entry), and always deletes its own entry in `.finally`.
  Safe-closed.

- **Exfiltrating raw rows / full chat transcripts through a read surface.** The `get_dashboard_state`
  tool and the `studio://dashboard/state` resource both call the single `projectStateForAI`
  (`executeToolOnState.ts:125-146`), which strips `runtime.dataSources[*].rows`/`adapter`, caps
  `fieldDistinctValues`, and reduces `doc.ai` to per-thread metadata (no message transcripts). The two
  live-query resource families (`studio://data/{id}`, `studio://dashboard/data-health`) run through
  `authorizeResourceDataAccess` (`mcp.ts:537-561`) — the same `isToolAllowed` + args-only policy consult
  - approval bridge the data tools use.

- **Structural prompt injection via state-derived strings.** `sanitizeForPrompt` escapes `<`/`>` and is
  applied at every state-derived interpolation in `buildAISystemPrompt.ts` (widget titles, field
  ids/labels/descriptions, distinct values, filter values, layout, cross-filter graph, enriched/rich
  context — including client-supplied `richContext` numeric fields routed through `String()` first).
  I checked each interpolation site; the escaping is comprehensive on the prompt path.

---

## Tier 2 — Design smells / real but lower-severity

### 2.1 `add_widget_filter` does not validate the target widget exists (data integrity + false success)

`executeToolOnState.ts:757-788` (`add_widget_filter`). Every other entity-targeting tool in this file
validates existence before mutating and returns an actionable error otherwise — `remove_widget`,
`remove_page`, `set_widget_width`, `update_widget`, `set_widget_forecast`, `rename_page`,
`set_active_page`, and the shared `planRemoveFilter` (whose own comment at lines 325-330 explicitly
frames this as "matching every other entity-targeting tool … which all validate existence and return
an actionable error"). `add_widget_filter` is the lone exception: it takes
`widgetId = String(args.widgetId ?? '')` and builds a filter scoped to `{ kind: 'widget', widgetId }`
with **no** `state.doc.widgets[widgetId]` check.

**Concrete failure (verified empirically in this worktree):**

```
add_widget_filter({ widgetId: 'does-not-exist', field: 'x', sourceId: 'src', operator: 'equals', value: 1 })
  → {"success":true,"filterId":"filter-…"}          // mutation committed
set_widget_width({ widgetId: 'does-not-exist', columns: 6 })
  → {"error":"Widget does-not-exist not found."}     // sibling tool rejects
```

Impact: a prompt-injected or merely-confused model that fabricates or stales a `widgetId` gets told
`success`, a dangling widget-scoped filter is committed to `doc.filters` (it will never match any
widget, so it silently has no effect and clutters state / undo history), and the model has no signal to
retry with a corrected id. Low security impact (a no-op filter, no leak, no escalation), but a genuine
correctness/consistency gap. Fix: add the same `if (!state.doc.widgets[widgetId]) return { error }`
guard the siblings use.

### 2.2 Residual SVG text-content injection via the donut centre `total` label

`chartRenderer.ts:572` (`renderDonut`) emits `…fill="#1a1a2e">${total.toLocaleString()}</text>`.
`total` is `data.reduce((s, d) => s + d.value, 0)` (line 526). The renderer sanitizes the
attribute-position fields (`sanitizeColors`, `sanitizeDimension`) and escapes every _label_/title/series
name through `esc()`, but `total` is interpolated into text content **raw**. `data[*].value` is declared
`number` in the `render_chart` schema yet is never validated at runtime, so a string `value` reaches
`reduce` and turns the sum into string concatenation, carrying an arbitrary payload into the SVG.

**Concrete failure (verified empirically in this worktree):**

```ts
renderChartSvg({
  type: 'donut',
  title: 'ok',
  data: [{ label: 'x', value: '5</text><script>alert(1)</script>' as any }],
});
// → …>05</text><script>alert(1)</script></text>…   (raw <script> in the returned SVG)
```

`renderChartSvg` is exported publicly and backs the MCP `render_chart` tool, which returns the SVG both
as an `image/svg+xml` base64 item **and** as a raw `text` item (`utilityTools.ts:44-55`). An SVG served
or rendered as a top-level document would execute the injected markup. This is the one spot the file's
own sanitization philosophy misses; note the donut is the _only_ renderer that prints a value-derived
number as text (pie/bar only print `Math.round`/coerced numerics or `esc()`-wrapped labels — I checked
each: bar's `${d.value}` label at line 220 is gated behind `barH > 16`, and any non-numeric `value`
makes `barH` NaN so it is never emitted, so bar is not exploitable). Severity is bounded (requires a
type-violating model-supplied `value` and an SVG rendered as a document, not an `<img>`), hence Tier 2
defense-in-depth rather than Tier 1. Fix options: coerce `total` through `esc(String(...))`, or (better)
validate/coerce `data[*].value` to a finite number in `sanitizeInput`. The `ARCHITECTURE.md` claim
(line 54) that the renderer validates model input "at one choke point … before any renderer interpolates
them into SVG attribute positions" is technically true only for _attribute_ positions — it does not
cover this _text-content_ path, so the doc reads as more complete than the code is.

---

## Tier 3 — Minor / cosmetic

- **`add_page_filter` doesn't confirm an active page exists.** `executeToolOnState.ts:721-753` scopes
  the new filter to `{ kind: 'page', pageId: state.doc.dashboard.activePageId }` without checking that
  page exists (unlike `add_widget`, which errors when there is no active page). If `activePageId` is
  empty/stale, a page filter with a bogus `pageId` is committed. Much lower likelihood than 2.1 (the
  active page is normally valid), but the same class of missing-existence-check.

- **`parseSSE` splits only on `\n`.** `parseSSE.ts:24`. It happens to tolerate `\r\n` because
  `payload = line.slice(6).trim()` strips the trailing `\r`, but the `\r` handling is incidental rather
  than intentional. A comment or an explicit `\r?\n` split would make the CRLF-safety a property rather
  than an accident.

- **Chart renderers produce NaN geometry for all-non-positive data.** e.g. a `bar`/`donut` where every
  `value <= 0` yields `maxVal`/`total` of `0` and then `v / 0` in the coordinate maps. Output is a
  broken-but-harmless SVG (no injection). A guard that renders a "no data" placeholder (as `line`/
  `stacked_bar` already do) would be more robust.

---

## Notes on documented tradeoffs (checked, found correct/deliberate)

- **MCP default policy is ALLOW-ALL, not `createDefaultToolPolicy()`** (`mcp.ts:176`, `types.ts:169-177`).
  Deliberate and documented: MCP has no approval-pause channel, so defaulting destructive tools to
  require-approval would break every existing MCP integration. Destructive tools are still flagged via
  `destructiveHint` annotations (derived from the shared registry, so chat and MCP can't drift). Correct.

- **Skill `promptFragment` is interpolated raw** (not `sanitizeForPrompt`-escaped) in
  `buildAISystemPrompt.ts:690-696`, while the skill `name`/`mode` are escaped. I considered this an
  injection vector but concluded it is a deliberate design boundary, not a defect: `promptFragment` is
  intended to be markdown instructions (escaping would break it), and skills are an app-configured
  feature carried in the request body — the same client that supplies `messages` supplies `skills`, so
  a browser that wanted to inject system-level text could equally craft the conversation. It grants no
  capability beyond what the request author already has. Worth keeping an eye on only if a host ever
  forwards _third-party/user-authored_ skills into a trusted request; that would be an app-layer (host)
  responsibility, not a middleware bug.

- **`hidden` data sources remain addressable by id** via `studio://schema/{id}` / `studio://data/{id}`
  (`resources.ts:106-114`). Documented as a listing-only declutter flag, not an access boundary; hosts
  needing a hard boundary enforce it in `queryDataSource`. The live-row resources still pass
  `authorizeDataAccess`. Consistent and intentional.

- **`rename_thread` stamps `state.doc.ai?.activeThreadId`** (`executeToolOnState.ts:1102-1134`) so the
  correct thread is renamed even if the user switched threads mid-run, and `projectStateForAI` never
  echoes other threads' transcripts back. Cross-thread isolation holds.

- **`query_data_source` never enters the `executeToolOnState` dry-run** (`{ effect: 'external' }`,
  `executeToolOnState.ts:1144`); its side-effectful dispatch consults the policy args-only _before_
  running (`toolDispatch.ts:344-397`). This honours the PURITY INVARIANT documented at the top of
  `toolPolicy.ts` — verified the invariant is not violated by any other `TOOL_IMPLS` entry (all others
  are pure `applyMutation` plans).
