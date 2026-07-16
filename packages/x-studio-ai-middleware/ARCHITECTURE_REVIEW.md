# @mui/x-studio-ai-middleware — Architecture & Correctness Review

Tiers: 0/2/2

Fresh clean-slate review of the whole package (`src/**`). The trust boundary is
exceptionally well-hardened after 13 prior rounds: every state-derived string
reaching a prompt goes through the single `sanitizeForPrompt` choke point; every
SVG interpolation goes through `sanitizeInput`/`esc` with hex-validated colors and
numeric-coerced dimensions/values; every model-supplied entity id lookup is
`Object.hasOwn`-guarded; config keys/values, chart types, filter operators, field
types, and widget kinds are all validated against the shared schema; the policy
chokepoint (`executeToolWithPolicy` / `consultToolPolicyArgsOnly`) respects the
documented purity invariant on both transports; and the read-surface redaction
contract (`projectStateForAI`) is shared by the tool and the MCP resource so they
cannot drift. I found **no Tier-1 defect**. The findings below are cross-transport
consistency gaps and minor items.

---

## Tier 1 — security / correctness bugs

None found. The SVG renderer, prompt builder, state executor, MCP resources, and
tool policy all hold up: no unsanitized model value reaches prompt or SVG output,
no id lookup walks the prototype chain, and no mutating tool bypasses the policy.

---

## Tier 2 — robustness / consistency

### T2-A. MCP approval bridge shows the human the model's _claimed_ entity label, not the real one

**Where:** `src/mcp.ts:387` (`bridgeApproval` → `approvalHandler({ … input: args ?? {} … })`), versus `src/agenticLoop/toolDispatch.ts:140` (`buildApprovalDisplayInput`) used at lines 323 / 364 / 447.

**What's wrong:** The chat transport deliberately rewrites the human-facing
approval label before surfacing it: `buildApprovalDisplayInput` replaces the
model-supplied `remove_widget.widgetTitle` / `remove_page.pageTitle` /
`apply_bulk_update.widgetRemovals[]` with the **real** titles read from state, with
the documented rationale that "a prompt-injected model could claim `widgetTitle:
'harmless widget'` while `widgetId` targets something else, so the human would
approve a removal based on a title the model chose."

The MCP transport applies **no such enrichment**. `bridgeApproval` forwards the raw
model args verbatim as `ctx.input` to the host's `approvalHandler`
(`StudioMcpOptions.approvalHandler`, `src/mcp/types.ts:189`). `buildApprovalDisplayInput`
is never imported in `mcp.ts`.

**Why it matters (concrete scenario):** A host runs the MCP server with a
`toolPolicy` that requires approval for `remove_widget` and an `approvalHandler`
that renders `ctx.input.widgetTitle` in its confirmation UI (the natural thing to
do — `input` is the only place a human-readable label lives; `proposed.effects`
carries only opaque ids). A prompt-injected model emits `remove_widget({ widgetId:
"<the-revenue-KPI>", widgetTitle: "scratch chart" })`. The operator sees "Remove
_scratch chart_?", approves, and the revenue KPI is deleted. On the chat transport
this exact attack is neutralized; on MCP it is not.

**Fix:** Export `buildApprovalDisplayInput` from `toolDispatch.ts` (or lift it to a
shared module) and call it in `bridgeApproval` before invoking `approvalHandler`,
so the MCP approval context carries the state-derived label just like chat:

```ts
const displayInput = buildApprovalDisplayInput(toolName, args ?? {}, stateBox.current);
const approved = await approvalHandler({
  transport: 'mcp',
  toolName,
  input: displayInput,
  state: stateBox.current,
  proposed,
  usage: sessionUsage,
});
```

(Mitigation that already exists: a careful host can cross-check `proposed.effects.removedWidgetIds`, which _is_ derived from real state — so this is a display-integrity gap rather than a full auth bypass, hence Tier 2 not Tier 1.)

---

### T2-B. Sibling raw-row MCP data tools are gated on their own name, not on `query_data_source`, breaking the "governs all raw-row access" contract

**Where:** `src/mcp.ts:446-461` (dispatch-table tools consulted via `consultToolPolicyArgsOnly(toolName, …)` under each tool's **own** name) versus `src/mcp/resources.ts:36-62` / `src/mcp.ts:555-583` (`authorizeResourceDataAccess` maps raw-row _resource_ reads onto the `query_data_source` tool name, documented as "the one whose allowedTools/toolPolicy restriction a host expects to govern **all raw-row access**").

**What's wrong:** `describe_data_source` (`src/mcp/queryTools.ts:150`, returns up to
10 **raw sample rows** + `sampleValues`), `get_field_values` (distinct field values

- counts), and `compute_field_stats` each call `data.queryDataSource(...)` and
  return real row-derived data. But their args-only policy consult runs under their
  own tool names, so a host `toolPolicy` written to gate `query_data_source` — e.g.
  a per-`sourceId` deny rule — is never consulted for them.

**Why it matters:** A host that denies `query_data_source` for a sensitive
`sourceId` (relying on the stated contract that this governs all raw-row access,
which the resource path honors and threads `sourceId` for) still leaks 10 raw rows
of that source via `describe_data_source({ sourceId })`, because the consult there
sees `toolName: 'describe_data_source'` and the per-source rule keyed on
`query_data_source` does not match.

**Hedge / why Tier 2 not Tier 1:** Each of these tools _is_ independently
allow-listable (via `allowedTools`) and independently policy-consulted, so a host
that knows to also target them can gate them. The defect is that the contract
`resources.ts` explicitly states for `query_data_source` ("governs all raw-row
access") is not upheld uniformly across the sibling row-returning tools.

**Fix:** Either (a) route the row-returning data tools' policy consult under the
`query_data_source` name (as the resource path does) so one `query_data_source`
rule governs every raw-row surface, threading `sourceId` into `ctx.input`; or (b)
narrow the `resources.ts` documentation to stop claiming `query_data_source`
governs _all_ raw-row access and instead require hosts to gate each data tool by
name. Option (a) matches the resource-path design and is less surprising.

---

## Tier 3 — minor / documentation

### T3-A. `studio://dashboard/data-health` gates once without a per-source descriptor

**Where:** `src/mcp/resources.ts:313-345`; gate at 320 calls `authorizeDataAccess()`
with no `input`, then COUNTs every non-hidden source.

**What's wrong:** Unlike `studio://data/{sourceId}` (which threads `{ sourceId }`
into the consult, per finding 2.3's fix), `data-health` runs one COUNT per source
after a single source-agnostic authorization. A per-source `toolPolicy`/`approvalHandler`
rule cannot distinguish which sources' row COUNTs are being exposed — a source the
host denies individually still contributes its count here.

**Why it's Tier 3:** Only aggregate row _counts_ leak (not rows), low sensitivity,
and the surrounding comments already acknowledge it is "gated once against the
tool-name allow-list/policy." Fix if desired: authorize per-source and drop denied
sources from the `counts` map.

### T3-B. Stale dispatch-location references in `executeToolOnState.ts` comments

**Where:** `src/executeToolOnState.ts:173-176` and `:1530-1531`.

**What's wrong:** Both comments state `query_data_source`'s real chat dispatch
"lives in `agenticLoop.ts` (chat)". Since the extraction, the chat dispatch lives
in `src/agenticLoop/toolDispatch.ts` (`dispatchToolCall`'s `if (name === 'query_data_source')`
branch), not `agenticLoop.ts` directly. Cosmetic; update the path.

---

## Notes on things checked and found correct (not findings)

- **SVG renderer:** `esc()` omits `'` but every attribute uses double quotes, and
  every text/attribute value is either hex-validated (colors), numeric-coerced
  (dimensions/values, incl. donut-center `total`), or `esc`'d — no injection path.
- **Prompt builder:** `describeWidget` routes 100% of value-bearing fields through
  `pushField`/`pushChartField`→`sanitizeForPrompt`; `text`/custom-kind config is
  never described, so those values never reach the prompt. Chart keys are gated on
  `getAllowedChartConfigKeys(resolveChartType(...))`, matching the `?? 'bar'`
  default used by `invalidChartConfigKeyError`.
- **`privateMode`:** all four state/row-returning tools (`get_dashboard_state`,
  `list_pages`, `summarise_page`, `query_data_source`) carry `privateModeExcluded`
  in the registry and are dropped from the advertised set _and_ rejected at the
  dispatch-time gate (`advertisedToolNames`).
- **State executor:** `set_widget_layout` and `apply_bulk_update`'s layout op enforce
  shape + duplicate + membership + active-page-ownership identically; per-batch
  running maps (`liveWidgetIds`, `currentChartTypes`, `addedTitleToId`) stay
  consistent across multiple deltas in one turn; `set_widget_forecast` and
  `update_widget` emit merge patches (never wholesale `changes.config`).
- **Filter operators (17), field types (5), and widget kinds (7)** are all validated
  against compile-time-locked schema lists; the few-shot operator list in the system
  prompt matches `STUDIO_FILTER_OPERATORS` exactly, and the `render_chart` schema
  enum matches the renderer's `ChartType` union.
