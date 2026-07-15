# Architecture & Correctness Review — `@mui/x-studio-ai-middleware`

**Tier1: 0 / Tier2: 1 / Tier3: 3**

Scope: clean-slate read of the current source (not prior findings). Focus areas as
directed: `executeToolOnState.ts`, `buildAISystemPrompt.ts`, the MCP resource/tool/prompt
layer, `chartRenderer.ts`, plus `toolPolicy.ts`, `agenticLoop*`, the data tools, and the
public handlers. This package has been through many prior hardening rounds and the
classic attack classes are, on this read, closed. What remains is one correctness
asymmetry and three minor items.

---

## Tier 1 — security / data-loss / model-reachable correctness

**None found.** The high-risk surfaces were verified sound (see "Verified-sound" below).
I specifically tried and failed to find: an unguarded model-controlled plain-object
lookup, an unsanitized state-derived string reaching a tagged prompt region, an SVG
attribute/text position reachable with an un-coerced value, a policy/authorization
bypass on either transport, or a snapshot-vs-delta data-loss path in
`apply_bulk_update`.

---

## Tier 2 — robustness / consistency

### T2-A. `set_widget_layout` / `apply_bulk_update` layout accept a widget that lives on ANOTHER page, silently duplicating it across pages

- `executeToolOnState.ts:799-814` (`set_widget_layout` membership check) and
  `executeToolOnState.ts:1323-1325` (`apply_bulk_update` layout `unknownLayoutIds`).

Both layout paths validate only that each id is a **known widget**
(`hasOwnEntity(state.doc.widgets, id)` / `liveWidgetIds.has(id)`). Neither checks that the
id belongs to the **active page**. The emitted `setWidgetLayout` / `applyBulkUpdate`
mutation targets the active page, and the reducer
(`x-studio-schema/src/applyMutation.ts` `setWidgetLayout.apply`, line ~946) filters rows
only against `state.widgets` (all pages) and replaces the _target_ page's `widgetRows` —
it performs **no cross-page cleanup**. So if the model passes an id that is currently on
page B into a `set_widget_layout` call for active page A, the widget is placed on page A
while still referenced by page B's `widgetRows`. The widget is now rendered on two pages,
sharing one config object.

Why it matters: reachable purely via model tool calls — `get_dashboard_state` exposes
every page's widget ids, so a model that mis-attributes an id (or a prompt-injected model
trying to smear a widget) produces a widget referenced by multiple pages, an
unusual/unsupported state that the UI must then render twice and that `removeWidget` only
partially reasons about. It is not data loss (the widget survives), which is why this is
Tier 2 rather than Tier 1.

Evidence it is unintended: the sibling `set_widget_width` handler
(`executeToolOnState.ts:852-874`) explicitly detects "widget is on another page" and
returns an actionable error rather than acting, and the `setWidgetColSpan` reducer has a
matching orphan-span guard. The two layout handlers lack the equivalent active-page
ownership check.

Fix direction: in both layout handlers, after the existence check, reject (or drop with a
`skipped`/error message, mirroring `set_widget_width`) any id whose widget is currently
referenced by a _non-active_ page's `widgetRows` — i.e. restrict layout membership to
"on the active page, unplaced, or added this batch," not merely "exists."

---

## Tier 3 — minor / drift

### T3-A. `sanitizeColors([])` bypasses the `DEFAULT_COLORS` fallback → `fill="undefined"`

- `chartRenderer.ts:103-114` (`sanitizeColors`), consumed by every renderer via the
  `colors = DEFAULT_COLORS` destructuring default.

`sanitizeColors` returns any array as-is after per-entry validation, so a model-supplied
`colors: []` yields `[]` (not `undefined`). The renderers' `colors = DEFAULT_COLORS`
default only fires on `undefined`, so `colors` stays `[]`, and `color([], i)` computes
`[][i % 0]` = `[][NaN]` = `undefined`. Every `fill`/`stroke` then renders literally as
`fill="undefined"`. This is a rendering degradation only — `"undefined"` carries no
`<`/`>`/`"`, so it is not a markup-injection vector (the injection guard for malformed
entries is intact for non-empty arrays). Fix: treat an empty array as absent
(`if (!Array.isArray(colors) || colors.length === 0) return undefined;`).

### T3-B. Few-shot prompt drift: `seriesType` (deprecated alias) vs `type` (canonical) for `ySeries`

- `buildAISystemPrompt.ts:369` teaches `ySeries: [{ ..., seriesType: "bar" }, { ..., seriesType: "line" }]`.
- `widgetConfigMeta.ts:49` (`KIND_CONFIG_LINES.mixed`) and `widgetConfigMeta.ts:103`
  (`CHART_TYPE_DOCS` mixed entry) teach the canonical `type: "bar"|"line"`.

Per the schema (`factories.ts` `normalizeChartSeries`, `applyMutation.ts`
`normalizeSeriesTypeAlias`), `type` is canonical and `seriesType` is a deprecated alias
that is normalized away on every live write, so both spellings function. But the primary
instruction block steers the model toward the deprecated key while the config-key docs
steer it toward the canonical one — an internal inconsistency worth aligning on `type`.

### T3-C. Display-only reads use bare `widgets[id]?.title` instead of the guarded `getWidget`

- `executeToolOnState.ts:554` (`list_pages`), `buildAISystemPrompt.ts:638-639`
  ("Other Pages" summary).

These read a widget title through a bare `widgets[id]?.title` for display, rather than the
`Object.hasOwn`-guarded `getWidget`/`getPage` discipline used at every existence-checking
site. They are harmless in practice — optional chaining plus a `Boolean`/`!= null` filter
means a prototype-member id (`"__proto__"`) resolves to an inherited value whose `.title`
is `undefined` and is then filtered out, with no success-report or state write keyed off
it — so this is a stylistic/consistency nit, not a live bug. Noted only so the guard
discipline stays uniform if these lines are ever repurposed into an existence check.

---

## Verified-sound (do not re-flag)

- **Prompt trust boundary.** `sanitizeForPrompt` is a genuine single choke point:
  `describeWidget`'s `pushField`/`pushQuoted`/`pushChartField` route _every_ value-bearing
  field through it (no raw `parts.push` of a state value), and `buildRichContextBlock`,
  `buildDashboardState` (incl. client-asserted `widgetColSpans` spans), `describeSource`,
  `serializeFieldForAI`, `buildSkillSection` (+ `neutralizeSkillBoundary`),
  `generateFieldDescriptions`, `handleCreateWidget`, and `mcp/prompts.ts` /
  `mcp/resources.ts` all escape state-derived strings before they enter a tagged region.
  Numeric-typed-but-client-supplied fields (`fieldStats`, `colSpan`) are explicitly
  `String()`-then-sanitized.
- **Read-surface redaction.** `projectStateForAI` is the single home for the
  `get_dashboard_state` tool AND the `studio://dashboard/state` / `system-prompt` /
  `schema/{id}` resources AND `query_data_source_examples` — rows/adapter stripped,
  distinct values capped, `doc.ai` reduced to per-thread metadata. The MCP resource,
  prompt, and data surfaces are all gated by `authorizeResourceStateAccess` /
  `authorizeResourceDataAccess`, which re-run the same `isToolAllowed` + args-only policy
  consult + approval bridge as the tool path, so hiding a tool also blocks the equivalent
  resource/prompt read.
- **Prototype-pollution / undefined-injection.** Every model-controlled lookup that gates
  an existence check or a write is `Object.hasOwn`-guarded: `getWidget`/`getPage`/
  `hasOwnEntity` in the executor, `getSource`/`getPage` in the prompt builder,
  `resolveSource` and the `schema/{id}` and `data/{id}` resource branches, `summarisePage`,
  `buildPageLayoutContext`, `buildApprovalDisplayInput`, the `TOOL_IMPLS` dispatch, and the
  MCP `toolHandlers` dispatch. `addedTitleToId`/`currentChartTypes` use `Map`;
  `buildWidgetFromArgs` uses `createDefaultWidget`'s `Object.hasOwn` kind table.
- **chartRenderer injection surface.** `sanitizeInput` coerces width/height (finite,
  in-range), colors (strict hex or default), every numeric `value` (finite), and every
  text field (String, then `esc()`); non-array `data`/`series`/`xLabels` degrade to
  placeholders; NaN-geometry guards render "No data provided." across all six renderers.
  No un-coerced value reaches an SVG attribute or text position (aside from the cosmetic
  empty-array case, T3-A).
- **Policy / purity.** The execute-then-gate (`executeToolWithPolicy`) vs args-only
  (`consultToolPolicyArgsOnly`, `mayMutate`) split is correctly enforced; `query_data_source`
  is `{ effect: 'external' }` with no `plan`; the mutation budget layers before the host
  policy via `Policy.all`; MCP serializes mutating calls via `mutationChain`; approval
  display labels are overridden from real state, not model-supplied titles;
  `waitForApproval` guards duplicate `toolCallId` collisions and always cleans up.
- **`apply_bulk_update` delta correctness.** Removals/additions/updates are emitted as
  deltas against live state; the running `currentChartTypes` map correctly validates a
  later same-batch config against a chartType an earlier same-batch update set; layout
  fields are attached only when layout actually changed (rows vs colSpans-only), avoiding
  the stale-snapshot lost-update class.
- **private mode / value validation.** `PRIVATE_MODE_EXCLUDED_TOOLS` (registry-derived)
  drops state-reading tools including `query_data_source` from both advertisement and the
  T1-1 dispatch gate; `invalidConfigKeyError` / `invalidConfigValueError` /
  `invalidChartConfigKeyError` / `invalidFilterOperatorError` / `resolveFieldType` and the
  `set_widget_forecast` boolean/`periods` coercions fail closed at the write source;
  `query_data_source`/`get_field_values`/`compute_field_stats` clamp `limit`/`offset`.
  Tool-name/registry drift is locked by the compile-time `AssertMutuallyAssignable` guard.
