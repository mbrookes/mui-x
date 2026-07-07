# Architecture & Tech-Debt Review — `@mui/x-studio-ai-middleware`

Independent review, 2026-07-07. Every claim below was verified against the current source
(not against `ARCHITECTURE.md`/`README.md`, which were treated as possibly stale).
File references are relative to `packages/x-studio-ai-middleware/`.

---

## Tier 1: Correctness & Security

### 1.1 MCP dispatch-table tools bypass the `toolPolicy` chokepoint entirely — including `query_data_source`

**Files:** `src/mcp.ts:370-373` (dispatch), `src/mcp.ts:266-286` (table contents);
contrast `src/agenticLoop.ts:486-510` (chat consults the policy for `query_data_source`)
and `src/toolPolicy.ts:50-63` (`ToolPolicyContext` doc: "Absent for server-tool skills,
query_data_source, and read-only tools — args-only judgment for those").

In `mcp.ts`'s `tools/call` handler, any tool found in the `toolHandlers` table returns
**before** `executeToolWithPolicy` is ever reached:

```ts
const handler = toolHandlers[toolName];
if (handler) {
  return await handler(args); // ← no policy, no usage.toolCalls increment
}
```

The table contains `get_dashboard_state`, `query_data_source`, `describe_data_source`,
`get_field_values`, `compute_field_stats`, `render_chart`, `get_recent_changes`, and
(when `data` is set) `summarise_page`. None of these consults `sessionToolPolicy`.

On the chat transport, `query_data_source` **does** consult the policy args-only before
executing (`agenticLoop.ts:489-497`), and read-only built-ins pass through
`executeToolWithPolicy` too. So the identical host policy — e.g. one that returns
`{ action: 'deny' }` for `query_data_source`, or gates all reads for a tenant — works on
chat and is **silently ignored on MCP**. This directly contradicts `toolPolicy.ts`'s
header ("the single authorization chokepoint … on BOTH transports") and the
`ToolPolicyContext` contract, which explicitly models args-only judgment for
`query_data_source`. `sessionUsage.toolCalls` is also never incremented for these calls,
so a usage-aware policy sees different counters per transport.

**Failure scenario:** host wires `toolPolicy: (ctx) => ctx.toolName === 'query_data_source' ? { action: 'deny', reason: … } : { action: 'allow' }`
to both transports as the docs recommend (same `data` object, same policy). An MCP client
calls `query_data_source` → the live DB query executes; the deny never runs.

**Fix sketch:** route dispatch-table tools through the args-only policy path before
invoking the handler (mirror `agenticLoop.ts`'s pre-execution consult: deny → `errorResult`,
require-approval → `approvalHandler` bridge), and increment `sessionUsage.toolCalls` there.

### 1.2 MCP commits stale state across async awaits — lost updates during `approvalHandler` / async policy

**Files:** `src/mcp.ts:385-428` (dry-run → `await policy` → `await approvalHandler` →
`commitMutation`), `src/mcp.ts:294-349` (`commitMutation` does `stateBox.current = result.nextState`).

`executeToolWithPolicy` computes `nextState` from `stateBox.current` captured at call
entry. Between that capture and `commitMutation`, the handler awaits (a) the host policy
(may be async) and (b) `approvalHandler` — which by design can take minutes of human
time. The MCP Streamable-HTTP transport does not serialize `tools/call` requests, so a
second call can execute and commit during that window. `commitMutation` then overwrites
`stateBox.current` with the **stale** `nextState`, silently discarding every mutation
committed in between (and `onStateChange` persists the rolled-back state).

**Failure scenario:** call A (`remove_page`, needs approval) starts; while the human
deliberates, call B (`add_widget`) commits. Human approves A → `stateBox.current`
becomes A's nextState computed _before_ B existed → B's widget vanishes from session
state and from the persisted snapshot, while B's tool result claimed success.

The chat loop is immune only because it is single-threaded per request and each request
owns its own state snapshot.

**Fix sketch:** re-run the pure plan against the _current_ `stateBox.current` at commit
time (re-dry-run after approval, the plan is pure and cheap), or serialize mutating
`tools/call` handling per session with a simple promise queue.

### 1.3 Opposite fail-open/fail-closed defaults for `require-approval` with no approval channel

**Files:** `src/agenticLoop.ts:354-362` (`runApprovalFlow`: no `approvalPending` map →
`return { kind: 'approved' }`), `src/mcp.ts:397-404` (no `approvalHandler` → deny with error).

When a policy returns `require-approval` and no approval channel is configured:

- **Chat** treats the call as **approved** and executes it (documented as "historical
  behavior" — `agenticLoop.ts:350-353`, and `AgenticLoopOptions.approvalPending` doc:
  "When not provided, destructive tools execute without approval").
- **MCP** **denies** it with "no approval channel configured".

A host that supplies the same custom policy to both transports (the documented pattern)
gets destructive mutations silently _executed_ on chat and refused on MCP. The chat
default is also fail-open for a security control: forgetting to wire `approvalPending`
in production removes the human-in-the-loop gate for `remove_page`/`remove_widget`/
`apply_bulk_update` with no error or warning anywhere.

**Fix sketch:** make chat fail closed (deny with an actionable message) behind a major
version or an explicit `approvalFallback: 'allow' | 'deny'` option defaulting to `'deny'`;
at minimum emit a loud one-time warning via `onToolError` when a require-approval is
auto-approved.

### 1.4 `allowedTools` cannot gate the MCP extra data tools — excluding `query_data_source` is trivially bypassed

**Files:** `src/mcp.ts:236-240` + `src/mcp.ts:358-373` (T1-3 gate applies only to
`studioAiToolNames`; comment: extra tools "are always-available by design"),
`src/mcp/dataTools.ts:160-370` (`describe_data_source`, `get_field_values`,
`compute_field_stats` run live aggregate queries).

The `allowedTools` gate (`mcp.ts:366`) checks
`studioAiToolNames.has(toolName) && !registeredToolNames.has(toolName)`. The five extra
tools are not `STUDIO_AI_TOOLS` members, so **no configuration short of removing `data`
entirely can disable them**, and (per 1.1) `toolPolicy` cannot intercept them either:

- A host that excludes `query_data_source` via `allowedTools` still exposes
  `describe_data_source` (schema + row count + 10 sample rows + per-field stats),
  `get_field_values` (up to 200 distinct values with counts), and
  `compute_field_stats` (full-table aggregates) — i.e. most of the data-access surface
  the exclusion was meant to close.
- `allowedTools: []` (lock everything down) still serves all five extra tools.

**Failure scenario:** host config `allowedTools: ['list_pages']`, `data` configured for
`summarise_page`. An MCP client calls `describe_data_source` per source and pages
through `get_field_values` — bulk data readout despite the allowlist.

**Fix sketch:** include `McpExtraToolName` members in the `allowedTools` filter (defaulting
to allowed when the option is omitted), and route them through the policy (1.1).

### 1.5 Server-tool-skill mutations bypass `maxMutationsPerRequest`

**Files:** `src/toolPolicy.ts:283-293` (`Policy.mutationBudget` denies only when
`ctx.proposed` is set), `src/agenticLoop.ts:445-475` (skill path: policy consulted with
`proposed: undefined`, then `execute()` runs and its `result.mutation` is committed and
counted _after_ the fact).

The mutation budget is expressed as "deny any call carrying a `proposed` mutation once
committed ≥ max". Skill calls are args-only (`proposed: undefined` — correctly, per the
purity invariant), so the budget policy always allows them; the mutation they return is
then committed unconditionally (`agenticLoop.ts:471-474`). Committed skill mutations _do_
increment the counter, so they starve subsequent built-in calls, but skills themselves
can commit an unlimited number of mutations under any `maxMutationsPerRequest`.

**Failure scenario:** `rateLimit.maxMutationsPerRequest: 3` as a runaway-agent guard; a
prompt-injected model loops a mutating server-tool skill 50 times in one request — all
50 mutations stream to the client as `state-mutation` events.

**Fix sketch:** check the committed count against the cap at the skill commit point
(before `yield { type: 'state-mutation', … }`), or pass a `mayMutate` hint in the
args-only policy context so the budget can deny mutating-capable skills up front.

### 1.6 `get_dashboard_state` dumps the raw state — including `runtime.dataSources[*].rows` — to the LLM provider

**Files:** `src/executeToolOnState.ts:118-131` (`output: JSON.stringify(state)`),
`src/studioAITools.ts:21-24` (tool description claims "Returns a **summary**"),
`packages/x-studio-schema` `dataTypes.ts` (`StudioDataSource.rows?: Record<string, unknown>[]`),
`src/mcp/resources.ts:111-121` (same full dump as a resource — acceptable there since the
host owns the box).

On chat, `dashboardState` comes from the client request body and — for client-side data
sources — carries the full `rows` arrays and `fieldDistinctValues`. Outside `privateMode`
a single `get_dashboard_state` call serializes **the entire dataset** into a tool-result
message that round-trips to the LLM provider: a data-exfiltration channel in the default
(non-private) mode, a token bomb against `maxTokensPerRequest` (the check runs only
_after_ the next model turn), and a direct contradiction of the advertised behavior
("Returns a summary of the current dashboard"). The carefully bounded system-prompt
serializer (`buildAISystemPrompt.ts` `describeSource`: visible fields only, ≤30 distinct
values) shows the intended altitude; the tool output ignores it. The system prompt's own
security rule "Never include raw data values from the dashboard in your text responses"
is undermined by handing the model those raw values as tool output.

**Fix sketch:** strip `runtime.dataSources[*].rows` (and cap `fieldDistinctValues`) from
the tool output — return `doc` + source _metadata_ only; keep the full dump exclusively on
the host-controlled MCP resource.

### 1.7 Shared `approvalPending` map: cross-request `toolCallId` collisions

**Files:** `src/agenticLoop.ts:229-259` (`waitForApproval` does
`approvalPending.set(toolCallId, …)` unconditionally), `src/handleAIChat.ts:204-231`
(documented pattern: one module-level map shared by all requests).

The map key is the provider-generated `tc.id` from the model stream. With the documented
module-level shared map, two concurrent requests whose providers emit the same tool-call
id (id reuse across requests is not guaranteed unique by any provider contract, and a
malicious client can replay a crafted conversation) collide: the second `set` overwrites
the first request's resolver, so request A's approval prompt can never be resolved
(hangs until the 120 s timeout ⇒ denied), while an approval intended for A resolves B's
destructive call. The approval decision is thus routable to the wrong mutation.

**Fix sketch:** namespace the key per request (`{requestId}:{toolCallId}` with a
loop-generated `requestId` echoed in the `tool-approval-request` event), or refuse to
overwrite an existing entry.

### 1.8 (Minor) Approval display hardening covers `remove_widget`/`remove_page` but not `apply_bulk_update`

**Files:** `src/agenticLoop.ts:319-334` (`buildApprovalDisplayInput`).

The prompt-injection defense that overwrites model-supplied display labels with real
state titles handles the two single-entity destructive tools only. `apply_bulk_update`
(also approval-gated) shows the raw model args: `widgetRemovals` is bare ids, so the
human approves against un-resolved identifiers and any narrative the model chose. Low
severity (execution keys off ids regardless), but the same hardening rationale applies.

**Fix sketch:** for `apply_bulk_update`, enrich the display input with
`{ id, title }` pairs resolved from `state.doc.widgets` for each removal id.

---

## Tier 2: Structural Duplication

### 2.1 The args-only "policy → deny → approval-pause" block is copy-pasted twice in `dispatchToolCall`

**Files:** `src/agenticLoop.ts:445-466` (server-tool skill branch) vs
`src/agenticLoop.ts:489-510` (`query_data_source` branch).

Both branches contain the byte-identical sequence: `usage.toolCalls += 1` → build the
same `ToolPolicyContext` (`transport: 'chat'`, `proposed: undefined`) → `deny` → return
`{error}` → `require-approval` → `buildApprovalDisplayInput` → `runApprovalFlow` →
aborted/denied handling. A third side-effectful tool would clone it a third time — and
this is exactly the kind of duplication that produced the chat/MCP drift in 1.1.
**Fix sketch:** extract `async function* consultArgsOnlyPolicy(name, input, ctx): ApprovalFlowResult | 'denied-output'`
and call it from both branches (and, per 1.1, from the MCP dispatch table).

### 2.2 MCP `get_dashboard_state` reimplements the pure tool with a _different_ output envelope

**Files:** `src/mcp.ts:267-271` (`jsonResult({ output: stateBox.current })`) vs
`src/executeToolOnState.ts:118-131` (`output: JSON.stringify(state)`).

Both sites carry comments claiming a "canonical output contract shared with the
chat/MCP path", but the shapes differ: chat's tool result **is** the state JSON; MCP's
text item is `{"output": {...state}}` — a wrapper object with the state nested under
`output` (and note other MCP mutation results nest `output` as a _string_ of JSON,
so even within MCP the `output` key's type is inconsistent). The MCP entry exists only
to skip the policy walk (which per 1.1 it shouldn't skip anyway).
**Fix sketch:** delete the table entry and let `get_dashboard_state` fall through to the
shared `executeToolWithPolicy` path like every other STUDIO_AI_TOOL.

### 2.3 Source-resolution + "Unknown data source" validation duplicated 4× with drifting messages

**Files:** `src/mcp/dataTools.ts:132-137` (`query_data_source`, with the
`studio://dashboard/state` hint), `:168-173` (`describe_data_source`, with hint),
`:257-259` (`get_field_values`, no hint), `:331-333` (`compute_field_stats`, no hint).

Same `stateBox.current.runtime.dataSources[sourceId]` + `tableName` check, four copies,
two message variants. The hint text also leaks an MCP resource URI into the chat
transport's tool output (chat models cannot read `studio://` URIs), a small
transport-appropriateness drift inherited from sharing the handler.
**Fix sketch:** one `resolveSource(stateBox, sourceId): { source } | { errorResult }`
helper; make the hint transport-neutral ("call get_dashboard_state / read
studio://dashboard/state").

### 2.4 Chat builds the entire `createDataToolHandlers` bundle per `query_data_source` call

**Files:** `src/agenticLoop.ts:520-526` (fresh factory per call, dummy
`recentChanges: []`, discards 6 of 7 handlers), `src/agenticLoop.ts:38-39`
(`DEFAULT_MAX_QUERY_ROWS = 1000` — a hand-mirrored copy of `mcp.ts:160`'s default,
"mirroring `mcp.ts`'s default" by comment rather than by a shared constant).

Correct but wasteful and misleading: it implies `query_data_source` needs the recent-
changes log and chart renderer. **Fix sketch:** export a focused
`createQueryDataSourceHandler(deps)` from `dataTools.ts` (used by both the factory and
the chat branch) and a shared `DEFAULT_MAX_QUERY_ROWS` constant.

---

## Tier 3: God-Files / Cohesion

### 3.1 `agenticLoop.ts` (1 162 lines) — five distinguishable responsibilities in one module

**File:** `src/agenticLoop.ts`.

Currently contains: (1) OpenAI wire-format types + `toOpenAIMessages` history
serialization (:41-137), (2) streaming tool-call delta accumulation (:139-214),
(3) approval machinery (`waitForApproval`, `runApprovalFlow`,
`buildApprovalDisplayInput`, :216-394), (4) `dispatchToolCall` — the entire chat-side
authorization/dispatch decision tree (:396-618), and (5) the loop itself with rate
limiting, budget wiring, and skill-collision filtering (:716-1162). The internal
sectioning is disciplined, but items 1-2 (pure, provider-protocol) and 3-4 (security-
critical) have completely different change cadences and reviewers; 1.5/2.1 above both
live in the seams of this file. **Fix sketch:** extract `openaiWire.ts`
(messages + accumulator) and `toolDispatch.ts` (approval + dispatch), leaving the loop
~400 lines.

### 3.2 `mcp/dataTools.ts` (574 lines) — misnamed grab-bag

**File:** `src/mcp/dataTools.ts`.

Despite the name, it holds the data-query tools **plus** `render_chart` (pure SVG,
no data config), `get_recent_changes` (session log, no data config), and ~190 lines of
`summarise_page` statistics/CSV/anomaly-detection logic. `createDataToolHandlers` is the
symbol both transports share, so its contents define the shared surface — the two
non-data tools riding along is why 1.4's "always-available" set is larger than it needs
to be. **Fix sketch:** split into `queryTools.ts`, `summarisePage.ts`, and move
`render_chart`/`get_recent_changes` beside their metadata in a `utilityTools.ts`.

### 3.3 Fine as-is (explicitly checked, nothing to flag)

- `executeToolOnState.ts` (818): one exhaustively-typed table, single responsibility;
  the `PureToolImpl`/`ExternalToolImpl` split is genuinely good design.
- `buildAISystemPrompt.ts` (774): ~180 lines are one prompt-copy constant; cohesive.
- `studioAITools.ts` (709): pure data + a load-bearing type assert.
- `mcp.ts` (459): a real composition root after the `mcp/` extraction. One nit: the
  inner `try/catch` at :381-431 duplicates the outer catch at :432-437 (both return
  `errorResult(String(err))`; only the outer logs), so mutation-path errors skip the
  error log — collapse to one.

---

## Tier 4: Testing Gaps

### 4.1 No test pins whether MCP dispatch-table tools consult the policy

**Files:** `src/mcp.test.ts:896-1060` ("toolPolicy chokepoint" suite covers only
mutation-path tools), `src/mcp/dataTools.test.ts` (tests handlers directly, below the
dispatch layer).

The suite would pass identically whether 1.1 is a bug or a design decision — there is no
test asserting that a deny-all policy blocks (or deliberately doesn't block)
`query_data_source` / `describe_data_source` / `get_dashboard_state` on MCP. Whichever
way 1.1 is resolved, add a test that a `toolPolicy` denying `query_data_source` is
honored on **both** transports (the chat side has one at `agenticLoop.test.ts:1260`;
MCP has none).

### 4.2 No concurrency test for the MCP stale-commit window

**File:** `src/mcp.test.ts` (all `tools/call` tests are strictly sequential).

The 1.2 lost-update is reproducible deterministically: start call A with an
`approvalHandler` that blocks on a deferred promise, run call B (`add_page`) to
completion, resolve A's approval `true`, then assert B's page still exists in
`stateBox.current`. Today that assertion fails; no test exercises it.

### 4.3 No test for skill mutations vs `maxMutationsPerRequest`

**Files:** `src/agenticLoop.test.ts:1496-1546` (budget tested with built-in `add_page`
calls only), `:655-775` (skill tests never combine with `rateLimit`).

A test with `maxMutationsPerRequest: 1` and a server-tool skill that returns a mutation
twice would document the 1.5 bypass (currently: both commit).

### 4.4 Approval-flow races untested: late resolution and shared-map collision

**File:** `src/agenticLoop.test.ts:459-654` covers timeout, abort, approve, deny — all
single-request, single-entry.

Untested: (a) host resolves `approved: true` _after_ the timeout already settled the
promise (expected: no commit — holds today only via the settled-promise semantics of
`waitForApproval`, which nothing pins); (b) two concurrent loops sharing one
`approvalPending` map with a colliding `toolCallId` (1.7 — currently the wrong request's
mutation gets approved; a test would force the design conversation).

### 4.5 Chat-side `query_data_source` unknown-source / no-`data` outputs untested at the dispatch layer

**Files:** `src/agenticLoop.test.ts:776-867` (happy path + rejected promise only);
the unknown-`sourceId` and missing-`data` branches (`agenticLoop.ts:513-535`) are only
covered via the MCP-facing `dataTools.test.ts`.

The chat wrapper does nontrivial work on the error path — extracts the first text item,
`JSON.parse`s it on `isError` to feed `onToolError` (`agenticLoop.ts:527-535`) — and
`JSON.parse` would throw on any future handler that sets `isError` with non-JSON text
(today safe only because `errorResult` always wraps JSON; nothing pins that coupling).
One chat-level test with an unknown `sourceId` asserting the `{error}` tool result and
the `onToolError` call would pin both.

### 4.6 The MCP `allowedTools` bypass for extra tools is unpinned in either direction

**File:** `src/mcp.test.ts:858-894` (T1-3 suite tests `get_dashboard_state` only).

Whether "extra tools ignore `allowedTools`" is a bug (1.4) or by design, no test asserts
it. `allowedTools: []` + `data` configured → `describe_data_source` currently succeeds;
add a test capturing the intended behavior once 1.4 is decided.

### 4.7 MCP resource `subscribe` accepts and stores arbitrary URIs

**Files:** `src/mcp/resources.ts:281-288`, `src/mcp.test.ts:188-206` (only checks the
handlers "run without error").

`subscribedUris.add(uri)` is unvalidated and unbounded (a client can grow the set
indefinitely with garbage URIs; only two URIs are ever notified). Minor DoS-hygiene +
an easy validation test (reject or ignore non-`studio://` URIs).
