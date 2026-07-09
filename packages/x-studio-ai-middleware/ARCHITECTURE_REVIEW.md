# Architecture Review — `@mui/x-studio-ai-middleware`

Independent, adversarial review of the current source (not prior review docs). Every
claim below was traced through the actual code, cross-file. Verification: `tsc -p
tsconfig.json` is clean and the full test suite (`x-studio-ai-middleware*`,
548 tests across 17 files) passes.

This package is the untrusted-LLM-input security boundary, so the review was
deliberately adversarial about privilege escalation, cross-thread/session data
leakage, policy-chokepoint bypass, and prompt injection. **The security posture is
genuinely solid** — the recent hardening holds up under scrutiny:

- `projectStateForAI` is the single redaction home for both read surfaces
  (`get_dashboard_state` tool and `studio://dashboard/state` resource); it strips
  `runtime.dataSources[].rows`/`adapter`, caps distinct values, and reduces `doc.ai`
  to per-thread metadata with no transcripts. Cross-thread history cannot leak.
- `privateMode` excludes read tools **and** `query_data_source` at both advertisement
  and dispatch (T1-1 gate), derived from the registry's `privateModeExcluded` fact.
- `sanitizeForPrompt` covers every state-derived string interpolated into a tagged
  prompt region, including the numeric `richContext.fieldStats` values.
- The approval flow guards against duplicate `toolCallId` across concurrent requests,
  substitutes the real entity title from state (not the model-supplied label), and the
  MCP mutating branch runs under a per-session mutex so a stale snapshot can't clobber a
  commit.
- `chartRenderer` sanitizes `width`/`height`/`colors` before SVG-attribute interpolation
  and escapes text content; config-key writes are fail-closed at kind + chart-type
  granularity.

Only one genuine correctness defect (low severity) and a handful of minor items were
found. The package is close to clean.

---

## Tier 1 — Correctness & Security

### 1.1 `remove_page_filter` / `remove_widget_filter` report `success: true` for a nonexistent filter (low severity)

`planRemoveFilter` (`executeToolOnState.ts:319-331`) — shared by both filter-removal
tools — builds a `removeFilter` mutation and returns
`{ success: true, filterId }` **unconditionally**, with no check that the filter
actually exists:

```ts
function planRemoveFilter(args, ctx): ToolExecutionResult {
  const filterId = String(args.filterId ?? '');
  const mutation: StateMutation = { type: 'removeFilter', args: { filterId } };
  return {
    output: JSON.stringify({ success: true, filterId }),
    mutation,
    nextState: applyMutation(ctx.state, mutation),
  };
}
```

The `removeFilter` reducer (`x-studio-schema/applyMutation.ts:911-920`) is a no-op when
no filter matches the id (it returns the same `state` reference). So a call with a stale
or wrong `filterId` mutates nothing yet the model is told the removal **succeeded**.

This diverges from _every other_ entity-targeting built-in tool, all of which validate
existence and return an actionable `{ error: "... not found" }` so the model can
self-correct: `remove_widget`, `remove_page`, `set_widget_width`, `update_widget`,
`rename_page`, `set_active_page`, `set_widget_forecast`. The filter tools are the lone
exception. Impact is bounded (no data corruption, no security boundary crossed), but the
tool's output contract lies to the model for a whole class of inputs, which is a genuine
correctness bug — a model that used a wrong id has no signal to retry.

**Fix:** look up `state.doc.filters.find(f => f.id === filterId)` first and return
`{ error: 'Filter <id> not found.' }` / `nextState: state` when absent, mirroring the
other remove tools.

**Related (cosmetic):** `remove_page_filter` and `remove_widget_filter` emit _identical_
`removeFilter` mutations keyed only by id, with no scope check — so `remove_page_filter`
can remove a widget-scoped filter and vice versa. The page/widget distinction in the two
tool names is purely cosmetic. Harmless (removal by id is unambiguous), but worth noting
if the existence check above is added: it could also assert the found filter's scope
matches the tool.

No other Tier 1 (security or correctness) issues were found.

---

## Tier 2 — Design smells

None beyond the correctness item above. The one/two-transport sharing is genuinely
unified (`executeToolOnState`, `STUDIO_AI_TOOLS`, `createDataToolHandlers`, the
`toolPolicy.ts` chokepoint, and the registry-derived fact sets are all shared verbatim,
with compile-time drift guards), so the classic "chat and MCP diverge" risk is
well-contained.

---

## Tier 3 — Minor / cosmetic

### 3.1 `reasoning-*` SSE events are declared in the protocol but never emitted

`StudioAISSEEvent` (`models/protocol.ts:92-96`) declares `reasoning-start`,
`reasoning-delta`, and `reasoning-end`, with comments stating the client renders them as
a collapsible "Thinking…" section. But `runAgenticLoop` (`agenticLoop.ts:436-449`) only
maps `delta.content` → `text-delta`; it never inspects any provider `reasoning` /
`reasoning_content` streaming field and never yields a `reasoning-*` event. So reasoning
tokens from providers that stream them (o1-style, or Claude extended thinking behind an
OpenAI-compatible gateway) are silently dropped. Either dead protocol surface or an
unimplemented capability — worth a decision (implement the mapping, or drop the event
types).

### 3.2 `apply_bulk_update` silently drops out-of-range `colSpans` (inconsistent with `set_widget_width`)

`apply_bulk_update` (`executeToolOnState.ts:1046-1052`) accepts a colSpan only when
`span >= 6 && span <= 24`, otherwise ignores it **without** recording it in the
`skipped` array. `set_widget_width` (`executeToolOnState.ts:634-646`) instead lets the
reducer clamp any value into 6–24 and reports the actually-applied value back to the
model. So `colSpans: { w1: 100 }` in a bulk call vanishes with no feedback, while
`set_widget_width(w1, 100)` applies 24 and reports 24. Minor behavioral divergence for
the same underlying operation, plus the model gets no `skipped` entry to learn its span
was rejected.

### 3.3 `describeWidget` reads several config keys via `(cfg as any)` casts

`buildAISystemPrompt.ts:218-236` reads `kpiTrend`/`kpiTrendComparison`/`kpiTrendInvert`
and `gridSortField`/`gridSortDirection`/`gridGroupByField` through `(cfg as any)` casts,
unlike the surrounding chart/kpi/pivot/map reads which are typed. This is a
type-completeness smell — those keys appear to be absent from the typed widget-config
unions, so the reads bypass the type system and would silently render `undefined` if a
key were renamed in the schema. Values are still routed through `sanitizeForPrompt`, so
there is no injection risk; purely a maintainability nit. (These keys _are_ documented to
the model in `widgetConfigMeta.ts`, so the type union, not the doc, is what's lagging.)

---

## Summary

- **Tier 1:** 1 finding (low-severity correctness: filter-removal reports success for a
  nonexistent id; every other entity tool validates existence).
- **Tier 2:** 0 findings.
- **Tier 3:** 3 findings (unemitted `reasoning-*` protocol events; `apply_bulk_update`
  silently drops out-of-range colSpans vs. `set_widget_width`'s clamp+report; `as any`
  config reads in `describeWidget`).

The security-critical surfaces (redaction, private-mode gating, prompt-injection
sanitization, the policy chokepoint, the approval race, the MCP mutation mutex) are all
correctly implemented. No cross-thread/session/tenant leak, no policy bypass, and no
prompt-injection vector was found.
