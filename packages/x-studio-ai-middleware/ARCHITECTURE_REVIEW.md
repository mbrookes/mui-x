# Architecture & Correctness Review — `@mui/x-studio-ai-middleware`

Fresh review performed against the current source (every file under `src/`, including
tests, read end-to-end). Scope emphasis: prompt injection, tool-execution security,
SVG/output injection, agentic-loop/tool-dispatch correctness, and architectural debt.

This package is in genuinely good shape. The trust-boundary work from prior rounds is
real and holds up: the T1-1 dispatch gate, the execute-then-gate policy chokepoint, the
`PureToolImpl`/`ExternalToolImpl` split, the `projectStateForAI` redaction, private-mode
tool exclusion, the resource-read authorization gate, the chart-renderer attribute
sanitization, and the SSE parser fix all check out. The findings below are the residue.

---

## Tier 1 — Security/correctness bugs with a clear repro

### 1.1 `describeWidget` interpolates widget config **values** into `<dashboard_state>` without `sanitizeForPrompt` — a tool-reachable stored prompt injection

**File:** `src/buildAISystemPrompt.ts`

Invariant 13 (ARCHITECTURE.md) and the `sanitizeForPrompt` doc comment claim it is _the_
single choke point through which **every** state-derived string passes before landing in a
tagged prompt region. `describeWidget` violates that claim in three hand-written
`parts.push(...)` lines that interpolate config values raw:

- Line 129: ``parts.push(`chartType: ${chartType}`)`` — `chartType` comes from
  `resolveChartType(cfg)`, which is just `cfg.chartType ?? 'bar'` with **no** validation or
  escaping.
- Lines 146–148: the forecast line interpolates `` `${periods}` `` raw
  (`const periods = cfg.forecast.periods ?? 3`).
- Line 267: ``parts.push(`showTotals: ${cfg2.pivotShowTotals}`)`` — raw.

Every other value in the function goes through `pushField` (which calls
`sanitizeForPrompt`) or an explicit `sanitizeForPrompt(...)`; these three do not.

**Mechanism / trigger:** config-key validation (`invalidConfigKeyError` →
`validateConfigKeysForKind`) is a **key-presence check only** — it never inspects values
(confirmed in `@mui/x-studio-schema/src/configKeyValidation.ts:466`). So an ordinary,
policy-passing tool call can store an arbitrary **string** in a config field that
`describeWidget` later prints raw:

- `set_widget_forecast({ widgetId, enabled: true, periods: "</dashboard_state> ...injected instructions..." })`.
  `set_widget_forecast` (`executeToolOnState.ts:1162`) never checks that `periods` is a
  number (`periods != null ? { periods } : {}`), and it only requires the target be a
  `line`/`area` chart — exactly the widgets for which `describeWidget` renders the forecast
  line (gated on `allowed.has('forecast')`).
- `update_widget({ widgetId, config: { pivotShowTotals: "</dashboard_state> ..." } })` on a
  `pivot` widget. `pivotShowTotals` is a valid pivot config key
  (`configKeyValidation.ts:388`), so the key gate passes; the value is stored verbatim.
- `chartType` is additionally reachable via a crafted/imported `dashboardState` request body
  (the body is client-asserted), since it is only value-validated on the tool-write paths.

**Consequence:** the persisted value is echoed into the trusted `<dashboard_state>` block on
the **next** `buildAISystemPrompt` call (the prompt is rebuilt per request). A value
containing `</dashboard_state>` followed by fabricated instructions closes the data block
early and injects into the trusted prompt region — the exact structural prompt-injection the
sanitize choke point exists to prevent. This is a stored/persistent injection: a model that
is tricked once (e.g. by a poisoned `query_data_source` result) can plant it, and it fires on
every subsequent turn/request that rebuilds the prompt.

**Fix:** route all three through `sanitizeForPrompt` (matching the numeric `fieldStats`
treatment already applied via `sanitizeForPrompt(String(v))` in `buildRichContextBlock`).
The layout-span suffix in `buildDashboardState` (`` `, ${span}col` ``, line ~552) is the same
class via a crafted body and should get the same treatment.

---

## Tier 2 — Lower-severity real issues

### 2.1 Body-supplied skill `promptFragment`s are injected into the system prompt verbatim, with no server-side override

**Files:** `src/buildAISystemPrompt.ts` (`buildSkillSection`), `src/agenticLoop.ts`,
`src/handleAIChat.ts`

`buildSkillSection` interpolates each skill's `promptFragment` raw into a `<skill>` block
(line ~693), and the skill `name`/`mode` are sanitized but the fragment body is not (by
design — a fragment is meant to be model instructions). The gap is that `effectiveSkills`
includes `body.skills` (client-asserted; see `runAgenticLoop`), and unlike `allowedTools`
and `privateMode` — which have hard server-side overrides in `handleAIChat` (intersection /
OR) — there is **no** server option to filter or disable client-supplied skills' prompt text.
`skillHandlers` only governs server-side _execution_, not what prompt text `body.skills`
contributes.

**Consequence:** a client can inject arbitrary content (including a `</skill>`-style break of
the tag framing) into the **system** prompt, which is higher-trust than the user role. The
marginal risk over "the user can already type instructions in a message" is real because the
content lands in the system region and a host has no lever to stop it. For a
multi-tenant/public endpoint this is worth an explicit server-side skill allow-list or a
`sanitizeForPrompt`-style neutralization of the `<skill>` boundary.

### 2.2 `renderScatter` has no empty-data guard — emits `NaN` SVG geometry

**File:** `src/chartRenderer.ts` (`renderScatter`)

`renderBar`/`renderLine`/`renderDonut`/`renderStackedBar` all render a "No data provided."
placeholder for empty/all-non-positive input, but `renderScatter` does not. With
`type: "scatter", data: []` (or `series` with no usable points), `points` is empty, so
`xMin = Math.min() = Infinity`, `yMax = niceMax(0) = 0`, and each tick computes
`py(0) = PAD.top + chartH - (0/0)*chartH = NaN`. The result is an SVG with `y1="NaN"` /
`y="NaN"` attributes on gridlines and tick labels.

**Trigger:** MCP `render_chart` with an empty scatter dataset (model-controlled args).
**Consequence:** malformed (though not injection-capable — `esc()` still applies to text and
the values are attribute-position numbers) chart output. Low severity; add the same
placeholder guard the other renderers use. (`renderPie` is safe by construction: all
`value <= 0` slices are skipped and the percentage math is guarded by `total > 0`.)

---

## Tier 3 — Architectural debt

### 3.1 The `sanitizeForPrompt` choke point is enforced per-interpolation by hand, so it is not actually a "single choke point"

Finding 1.1 exists because escaping is a _convention_ applied at every `${...}` site rather
than a structural guarantee. `describeWidget` mixes `pushField` (which sanitizes) with raw
`parts.push(\`...${value}\`)`lines, and the raw ones are precisely the ones that slipped.
Invariant 13's "single choke point" framing overstates the actual mechanism. A structural fix
would make regressions impossible: e.g. build the prompt from a small tagged-value type whose
only stringifier sanitizes, or have`describeWidget`accumulate`(key, value)`pairs and
sanitize once at the join, so no call site can interpolate an unescaped value. This same
fragility is why the numeric`fieldStats` values needed a later defense-in-depth pass.

### 3.2 Tool handlers validate config **keys** but never **value types**

`set_widget_forecast` accepting a string `periods`, and `update_widget`/`add_widget`
accepting arbitrary value types for any valid key, is the root enabler of 1.1 and can also
produce structurally-broken widgets (e.g. a non-numeric `periods`/`pivotShowTotals`) that the
client must then render. The write-side "fail-closed" story (invariant 12) is only about key
membership; values are trusted. A lightweight value-shape check for the small set of
scalar-typed config fields the tools populate (or at minimum coercing `set_widget_forecast`'s
`periods` to a number) would close both the injection surface and the malformed-widget hazard
at the source rather than only at the prompt boundary.

---

## Areas checked and found correct (not findings)

- **T1-1 dispatch gate / advertisement-is-not-authorization**: `dispatchToolCall`'s
  `advertisedToolNames` check and MCP's `isToolAllowed`/`registeredToolNames` both reject
  unadvertised calls before execution. Private-mode exclusion (`PRIVATE_MODE_EXCLUDED_TOOLS`)
  is enforced at the advertised-list level, not just the prompt.
- **Execute-then-gate purity**: `executeToolOnState` is pure; the only `external` tool
  (`query_data_source`) is unreachable through it and is authorized args-only. The mutation
  budget correctly gates `mayMutate` skills and ignores read-only calls.
- **`projectStateForAI` redaction**: rows/adapter stripped, distinct values capped, `doc.ai`
  reduced to thread metadata; shared by the `get_dashboard_state` tool and the
  `studio://dashboard/state` resource, so they cannot drift.
- **MCP resource live-query authorization**: `authorizeResourceDataAccess` gates
  `studio://data/{id}` and `studio://dashboard/data-health` through the same
  `isToolAllowed` + args-only consult + approval bridge as the data tools; `schema`/
  `system-prompt` reads run no live query.
- **Chart-renderer attribute injection**: `sanitizeColors` (strict hex) and
  `sanitizeDimension` guard every attribute-position value; `esc()` guards text content;
  `render_chart` wraps everything in try/catch so a non-array `colors`/`data` degrades to an
  error result rather than throwing out of the handler.
- **Approval race**: `waitForApproval` races callback vs. timeout vs. abort, refuses
  duplicate `toolCallId`s without deleting the incumbent entry, and always cleans up.
- **SSE parsing**: CRLF handling and the no-trailing-line-without-terminator behavior are
  correct.
- **Tool-call delta accumulation**: `SYNTHETIC_INDEX_BASE` cannot collide with a real
  `index: 0`; id-only and positional fallbacks are sound.
- **MCP mutation mutex**: the snapshot→dry-run→policy→approval→commit sequence runs in a
  per-session chained critical section; read-only tools stay concurrent (read-only, safe).
