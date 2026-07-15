# Architecture Review — `@mui/x-studio-ai-middleware` (Iteration 12)

Summary: 0 Tier 1, 1 Tier 2, 0 Tier 3.

Fresh, clean-slate pass. Every file named in the brief was read in full; the review
did NOT carry over prior-round assumptions and re-derived each invariant from the
current source.

## Verified SOUND

The load-bearing security machinery holds under this pass:

- **Advertisement-is-not-authorization (invariant 9).** Chat's `dispatchToolCall`
  rejects any `name ∉ advertisedToolNames` (T1-1) BEFORE parse-coercion, skill,
  `query_data_source`, or built-in dispatch (`agenticLoop/toolDispatch.ts:298`).
  MCP's `tools/call` rejects `!isToolAllowed(toolName)` then `!handler &&
!registeredToolNames.has(toolName)` before either dispatch branch
  (`mcp.ts:423`,`:436`). Both surfaces `Object.hasOwn`-guard their dispatch-table
  lookup so a prototype-member tool name (`"constructor"`, `"toString"`) cannot
  resolve an inherited function (`mcp.ts:435`, `executeToolOnState.ts:1640`).
- **Private-mode read-tool exclusion (T1-2).** `PRIVATE_MODE_EXCLUDED_TOOLS` is
  derived from the registry's `privateModeExcluded` fact — `{get_dashboard_state,
list_pages, summarise_page, query_data_source}`, verified against
  `aiToolRegistry.ts` — and drops those from the advertised list entirely (not just
  from the prompt block), so an injected call is rejected as unadvertised, never
  redacted-after-the-fact (`agenticLoop.ts:282`,`:304`).
- **Server-side override enforcement (invariant 10).** `allowedTools` is the
  INTERSECTION of options and body; `privateMode` is `options || body`;
  `allowedSkills` drops un-vetted body skills before their `promptFragment` reaches
  the prompt builder (`handleAIChat.ts:365-385`). A dropped skill's handler is
  unreachable — it never enters `advertisedToolNames`, so T1-1 rejects it.
- **MCP resource/prompt authorization parity.** Live-query reads
  (`studio://data/{id}`, `data-health`, system-prompt enrichment) run
  `authorizeResourceDataAccess` mapped onto `query_data_source`; state-family reads
  (`studio://dashboard/state`, `system-prompt`, `schema/{id}`, and the
  `query_data_source_examples` prompt) run `authorizeResourceStateAccess` mapped
  onto `get_dashboard_state` (`mcp.ts:555-643`, `mcp/resources.ts`, `mcp/prompts.ts`).
  `resources/list`/`completion/complete` intentionally ungated (listing surfaces).
- **Data-exfiltration redaction is single-homed.** `projectStateForAI` strips
  `rows`/`adapter`, caps distinct values, and reduces `doc.ai` to thread metadata;
  both the `get_dashboard_state` tool plan and the `studio://dashboard/state`
  resource call it, so the two read surfaces cannot drift
  (`executeToolOnState.ts:127`).
- **Prompt-injection choke point (invariant 13).** `describeWidget` routes every
  value-bearing field through `pushField`/`pushQuoted` (only stringifier
  `sanitizeForPrompt`), including numeric config, forecast composites, and
  `ySeries`/`funnel*`/grid-column joins. `buildRichContextBlock` sanitizes
  `number`-typed `fieldStats`/`colSpan`/`rowCounts`. The four secondary entry
  points (`generateFieldDescriptions`, `handleCreateWidget`, `mcp/prompts.ts`,
  `resources/list`) all route interpolated state through `sanitizeForPrompt` inside
  tagged regions. `neutralizeSkillBoundary` closes `</skill>`. No sixth un-sanitized
  interpolation entry point was found in this sweep.
- **Execute-then-gate purity.** `TOOL_IMPLS` types purity: the sole `external` tool
  (`query_data_source`) has no `plan` and is unreachable via `executeToolOnState`;
  every pure tool computes `applyMutation` without I/O, so the dry-run is safe
  (`executeToolOnState.ts:528`, `toolPolicy.ts` PURITY INVARIANT).
- **Write-side fail-closed validation.** Kind (`BUILTIN_WIDGET_KINDS` with a
  compile-time completeness lock), chart-type, scalar value-shape, filter operator
  (shared `isStudioFilterOperator`), and `fieldType` (`VALID_FIELD_TYPES`) checks
  all reject rather than strip, and the `apply_bulk_update` running-chart-type map
  stays current across the batch (`executeToolOnState.ts:221-419`,`:1094-1445`).
- **`chartRenderer.ts` coercion choke point.** `sanitizeInput` guards
  dimensions/colors/values/text; every renderer has an empty/all-non-positive
  placeholder; `pie`/`donut` sum only positive values; `esc()` is defensively
  `unknown`-tolerant.

## Finding T2-1 — Unguarded prototype-member plain-object lookups in the prompt builders (documented as hardened; they are not)

- **Tier:** 2 (robustness/consistency — prototype-chain-unguarded plain-object lookup)
- **Primary site:** `packages/x-studio-ai-middleware/src/buildAISystemPrompt.ts:99`

  ```ts
  const source = widget.sourceId ? sources[widget.sourceId] : undefined;
  ```

- **Invariant.** Every model/client-influenced entity-id lookup into a `state.doc.*`
  / `state.runtime.dataSources` plain object must go through `Object.hasOwn`, so the
  executor/reader agrees with the reducer's own-property discipline and a
  prototype-member key (`"__proto__"`, `"constructor"`, `"toString"`, `"valueOf"`)
  cannot resolve a truthy INHERITED value. `executeToolOnState.ts` codified this via
  `getWidget`/`getPage`/`hasOwnEntity` (finding T2-1 of the ARCHITECTURE), and the
  ARCHITECTURE explicitly claims the sibling "`sourceId`/`pageId`/`focusedWidgetId`
  lookups in … `buildAISystemPrompt.ts` … are hardened in the same pass for
  consistency." Only the `focusedWidgetId` lookup (line 690) actually is.

- **Concrete reachable scenario.** `add_widget` (or `update_widget`,
  `apply_bulk_update` additions) builds `sourceId` as
  `args.sourceId ? String(args.sourceId) : undefined`
  (`executeToolOnState.ts:443`,`:672`) with no existence check, so a model can commit
  a widget carrying `sourceId: "__proto__"` (or a crafted request body can set it
  directly). On the next `buildDashboardState` pass, `sources["__proto__"]` resolves
  to `Object.prototype` (truthy), so the `if (source)` branch fires and the widget is
  described as `source: "undefined" (undefined)` instead of `no source`
  (`buildAISystemPrompt.ts:124-129`). The consequence is a model/actual-state desync
  in the trusted `<dashboard_state>` block — the exact class T2-1 was created to
  close — reported every turn. (No prompt injection: the resolved inherited members
  have `undefined` `.label`/`.id`, and `pushField` sanitizes regardless; no throw:
  property access on a prototype function does not throw. Impact is confined to the
  false description, which is why this is Tier 2, not Tier 1.)

- **Sibling-site sweep** (every model/client-influenced key → plain-object lookup
  that is NOT `Object.hasOwn`-guarded and NOT saved by an optional chain):
  1. `buildAISystemPrompt.ts:99` — `sources[widget.sourceId]`, reads `.label`/`.id`
     off the truthy inherited result. **Primary — unguarded, property-reading.**
  2. `buildAISystemPrompt.ts:509` — `pages[dashboard.activePageId]`; a crafted
     body `activePageId: "__proto__"` makes `activePage` truthy and renders a phantom
     `## Active page: "undefined"` block with `No widgets on this page yet.`.
  3. `buildPageLayoutContext.ts:25` / `:32` — `pages[pageId]` and
     `widgets[widgetId]` (feeds the MCP `studio://dashboard/system-prompt` resource);
     same class, keyed off client-body `activePageId`/`widgetRows`.
  4. `mcp/summarisePage.ts:91` — `dataSources[sourceId]` with model-set
     `widget.sourceId`; currently safe ONLY by accident (`!source?.tableName` early
     return, `Object.prototype.tableName === undefined`), the same incidental save the
     ARCHITECTURE flagged and fixed for `resolveSource`.
  5. Optional-chained / `filter(Boolean)`-protected and therefore inert:
     `buildAISystemPrompt.ts:512`/`:567`/`:611`, `executeToolOnState.ts:554`,
     `mcp/summarisePage.ts:77`. (Listed for completeness; not defects.)
     Guarded/own-key sites confirmed clean: `buildAISystemPrompt.ts:691`,
     `mcp/summarisePage.ts:59-60`, `mcp/resources.ts:385`/`:446`,
     `mcp/queryTools.ts:61`, `agenticLoop/toolDispatch.ts:149-152`.

- **Fix direction.** Add a `getSource(state, id)` /`getPage`-style
  `Object.hasOwn`-guarded helper in `buildAISystemPrompt.ts` (mirroring
  `executeToolOnState.ts`'s `getWidget`/`getPage`) and route lines 99 and 509 through
  it; apply the same guard to `buildPageLayoutContext.ts:25`/`:32` and make
  `mcp/summarisePage.ts:91`'s safety explicit rather than incidental. Alternatively
  reconcile the ARCHITECTURE's T2-1 hardening claim with reality if the residual is
  deemed acceptable — but the guard is the cheaper reconciliation and matches the
  discipline already applied one file over.
