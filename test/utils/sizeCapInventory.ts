import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SizeCapRoot } from './sizeCapScan';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGES = resolve(REPO_ROOT, 'packages');

/**
 * The trust boundaries whose size caps are inventoried, walked recursively.
 *
 * An explicit, reviewable list rather than "the directory this test happens to sit in".
 * The predecessor of this scan read ONE non-recursive directory in ONE package, so a cap
 * added in a new subdirectory — or in either of the two OTHER packages that enforce the
 * same shared limits — was invisible to it, and a real one was (measured) shipped unpinned
 * in `x-studio/chat` while the schema-only scan stayed green.
 *
 * `x-studio/chat` is scoped to `StudioChatPanel` rather than the whole package on purpose:
 * that directory is where x-studio imports the shared wire limits across the package
 * boundary and enforces them on server-supplied payloads that land in the PERSISTED doc.
 * The rest of `x-studio` compares lengths too, but against render/UI thresholds
 * (`MAX_PER_ROW`, `DS_PREVIEW_ROWS`, …) whose failure mode is a layout, not a payload.
 * Widening this root is fine — it costs inventory rows, not correctness.
 */
export const SIZE_CAP_ROOTS: SizeCapRoot[] = [
  { label: 'x-studio-schema', dir: resolve(PACKAGES, 'x-studio-schema/src') },
  { label: 'x-studio/chat', dir: resolve(PACKAGES, 'x-studio/src/components/StudioChatPanel') },
  { label: 'x-studio-data-middleware', dir: resolve(PACKAGES, 'x-studio-data-middleware/src') },
];

/** Where a site's two-direction probe lives, or why it does not have one here. */
export interface SizeCapEntry {
  /** `<label>/<file>:<enclosing declaration>#<n>`, as produced by `findSizeCapSites`. */
  site: string;
  /**
   * The test file carrying a two-direction probe for THIS clause — a payload at the cap
   * that is accepted and the same payload one over that is rejected — or `null`.
   *
   * A non-null value is checked, not trusted: the named file asserts that the set of sites
   * claiming it matches the set of probes it actually declares, so a probe cannot be
   * deleted while the inventory still claims it.
   */
  probedIn: string | null;
  /** Why there is no probe. Required when `probedIn` is `null`; a claim a reader can check. */
  why?: string;
}

const BOUNDED_STRING_GUARDS = 'x-studio-schema/src/boundedStringGuards.test.ts';
const APPROVAL_LIST_LIMITS = 'x-studio/src/components/StudioChatPanel/studioBackendAdapter.test.ts';

/**
 * Every size-cap clause at the boundaries above.
 *
 * Being listed here is NOT the same as being pinned — it is the weaker, cheaper claim that
 * somebody looked at the clause and decided. That decision is the point: the scan turns
 * "a new cap was added" from silence into a failing test, and the only way to make it pass
 * is to write a probe or to write down why not.
 *
 * The `why` lines record the state measured by a mutation sweep over these three packages:
 * each clause was relaxed one at a time (token-preserving, e.g. `<= MAX` -> `<= MAX * 1000`)
 * and the suite re-run, so "killed by N tests" below is an observation, not an expectation.
 *
 * ── The 25 rows the LIMIT-SIDE recogniser added, and why they matter more than a count ──
 *
 * Until the scan grew its second recogniser (see `sizeCapScan.ts`) this list had 54 rows and
 * a green completeness test, and 25 real limit comparisons inside these same three roots were
 * in none of them — every one a cap whose measured quantity is a RUNNING TOTAL or a HOISTED
 * `const`, so the measurement was not lexically inside the comparison. Two whole named limits
 * (`MAX_PREDICATE_VALUES_PER_DESCRIPTOR`, and the tool-input/approval-input budgets) had no
 * row anywhere.
 *
 * That is worse than an off-by-25, because the invisible ones were systematically the
 * AGGREGATE caps, and an aggregate cap is the STRONGER member of its pair: it exists because
 * the per-item cap beside it is not enough, and `handler.ts` says exactly that in the comment
 * above `entryCount.total`. The enumeration was listing the clause that is admittedly
 * insufficient and could not see the clause added to close it. Every one of the 25 was
 * measured KILLED by its own tests, so this was an enumeration defect rather than 25 live
 * holes — but the enumeration's whole value proposition is "the next cap added here cannot be
 * silent", and the class that was silent is the class each of these files reaches for second.
 */
export const SIZE_CAP_INVENTORY: SizeCapEntry[] = [
  // ── x-studio-schema: the wire parser and the reducer/load-boundary repair ──
  {
    site: 'x-studio-schema/internalGuards.ts:repairFilterDependsOn[dependsOn.length <= MAX_ARRAY_LENGTH]#0',
    probedIn: null,
    why: 'array cap; pinned by internalGuards.test.ts (an over-long dependsOn array is stripped).',
  },
  {
    site: 'x-studio-schema/internalGuards.ts:repairFilterDependsOn[item.length <= MAX_STRING_LENGTH]#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue[value.length <= MAX_STRING_LENGTH]#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue[value.length <= MAX_ARRAY_LENGTH]#0',
    probedIn: null,
    why: 'array cap on a nested value; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue[keys.length <= MAX_RECORD_KEYS]#0',
    probedIn: null,
    why: 'record KEY-COUNT cap (MAX_RECORD_KEYS), not a string length; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue[key.length <= MAX_STRING_LENGTH]#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isString[value.length <= MAX_STRING_LENGTH]#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isOptionalString[value.length <= MAX_STRING_LENGTH]#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isSafeId[value.length <= MAX_STRING_LENGTH]#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isStringArray[value.length <= MAX_ARRAY_LENGTH]#0',
    probedIn: null,
    why: 'array cap; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isStringArray[item.length <= MAX_STRING_LENGTH]#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isStringMatrix[value.length <= MAX_ARRAY_LENGTH]#0',
    probedIn: null,
    why: 'array cap on the outer matrix; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isFiniteNumberRecord[keys.length <= MAX_ARRAY_LENGTH]#0',
    probedIn: null,
    why: 'key-COUNT cap; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isFiniteNumberRecord[key.length <= MAX_STRING_LENGTH]#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:applyBulkUpdate[args.addedWidgets.length > MAX_ARRAY_LENGTH]#0',
    probedIn: null,
    why: 'array cap on addedWidgets; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:applyBulkUpdate[args.updatedWidgets.length > MAX_ARRAY_LENGTH]#0',
    probedIn: null,
    why: 'array cap on updatedWidgets; pinned by parseStateMutation.test.ts.',
  },

  // ── x-studio-schema, limit-side: the caps whose measurement is a counter or a total ──
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue[depth > MAX_DEPTH]#0',
    probedIn: null,
    why:
      'the recursion-DEPTH bound of the wire parser, and the sibling of five inventoried ' +
      'length caps in the same function. The measured quantity is a counter threaded through ' +
      'the recursion, never a `.length`, so no measurement-side scan could ever see it. ' +
      'Pinned (measured: relaxing it is killed by 12 tests).',
  },
  {
    site: 'x-studio-schema/docScreening.ts:isValidExpressionNode[depth > MAX_EXPRESSION_DEPTH]#0',
    probedIn: null,
    why:
      'the load-boundary AST-depth screen on an expression field, twice as strict as the ' +
      'evaluator guard beneath it. Pinned (measured: relaxing it is killed by 2 tests).',
  },
  {
    site: 'x-studio-schema/applyMutation.ts:rebalanceRowSpans[anchorTotal > GRID_COLS]#0',
    probedIn: null,
    why:
      'layout invariant rather than a payload bound: a row whose spans already exceed the ' +
      'grid is left alone instead of rebalanced. Pinned (measured: killed by 3 tests).',
  },
  {
    site: 'x-studio-schema/applyMutation.ts:rebalanceRowSpans[anchorTotal + absorberTotal <= GRID_COLS]#0',
    probedIn: null,
    why:
      'the same layout invariant on a SUM of two running totals — the exact shape the ' +
      'measurement-side recogniser cannot see. Pinned (measured: killed by 8 tests).',
  },
  {
    site: 'x-studio-schema/applyMutation.ts:enforceLayoutColSpans[sum > GRID_COLS]#0',
    probedIn: null,
    why:
      "running total of a row's column spans, accumulated in the statement above the " +
      'comparison. Pinned (measured: killed by 8 tests).',
  },
  {
    site: 'x-studio-schema/statePersistence.ts:migrateState[fromVersion > CURRENT_SCHEMA_VERSION]#0',
    probedIn: null,
    why:
      'NOT A SIZE CAP. A schema-version ordering check (refuse to migrate FROM the future), ' +
      'listed because the limit-side recogniser deliberately over-approximates: it asks only ' +
      'whether one operand references a declared numeric constant, and a version number is ' +
      'one. Real guard all the same, and pinned (measured: killed by 4 tests).',
  },
  {
    site: 'x-studio-schema/statePersistence.ts:deserializeState[claimedVersion > CURRENT_SCHEMA_VERSION]#0',
    probedIn: null,
    why:
      'NOT A SIZE CAP, same reason as the row above: a persisted doc claiming a future schema ' +
      'version is rejected at load. Pinned (measured: killed by 3 tests).',
  },

  // ── x-studio/chat: the same shared limits, enforced across the package boundary ──
  {
    site: 'x-studio/chat/autoSubmit.tsx:attempt[store.state.messageIds.length > messageCountBefore]#0',
    probedIn: null,
    why:
      'NOT A CAP. `store.state.messageIds.length > messageCountBefore` asks whether the ' +
      'submit actually appended a message; nothing is bounded and there is no threshold to ' +
      'relax. Listed because the scan deliberately over-approximates on the right operand ' +
      '(see sizeCapScan.ts): the cost of never missing a cap written against a variable is ' +
      'a handful of rows like this one.',
  },
  {
    site: 'x-studio/chat/chatTurnMutations.ts:record[turns.size > MAX_TRACKED_TURNS]#0',
    probedIn: null,
    why:
      'turn-ledger retention cap on a Map `.size`; pinned by chatTurnMutations.test.ts ' +
      '(round 15). This is the cap the scan was rebuilt for: the file had no test file at ' +
      'all and the previous scan could not see a `.size` cap, so the inventory reported ' +
      'everything accounted for while this sat unpinned inside a walked directory.',
  },
  {
    site: 'x-studio/chat/generateInsight.ts:buildChartWidgetSummary[result.xLabels.length > maxRows]#0',
    probedIn: null,
    why:
      'prompt-context TRUNCATION of a heatmap axis, not an admission check: the over-cap ' +
      'branch appends "showing first N" and the rows are sliced either way, so relaxing it ' +
      'lengthens a prompt rather than admitting a payload. Bound is a parameter (`maxRows`), ' +
      'which is why the previous name-matching scan could not see it.',
  },
  {
    site: 'x-studio/chat/richContext.ts:strideSample[rows.length <= max]#0',
    probedIn: null,
    why:
      'MAX_STATS_ROWS, passed in as `max`; pinned by richContext.test.ts. Round 14 reported ' +
      'this cap as unpinned and added its file to the scan in the same commit — and the ' +
      'scan still could not see it, because the bound is an argument rather than a name.',
  },
  {
    site: 'x-studio/chat/sseUtils.ts:parseSSEStream[buffer.length > MAX_BUFFER_SIZE]#0',
    probedIn: null,
    why: 'SSE read-buffer cap; pinned by sseUtils.test.ts (an un-delimited stream aborts).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:truncateToWireSize[wireStringSize(value) <= max]#0',
    probedIn: null,
    why:
      'the fast path of a TRUNCATION helper (return the value whole when it already fits), ' +
      'not an admission check — the function returns a prefix rather than rejecting. Its ' +
      'callers are the sites that decide what the budget is, and those are inventoried ' +
      'separately. Exercised throughout studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:truncateToWireSize[wireStringSize(value.slice(0, mid)) <= max]#0',
    probedIn: null,
    why:
      'the binary-search step of the same truncation helper: it is the LOOP INVARIANT, not a ' +
      'bound on a payload. Relaxing it does not admit more data, it returns a wrong prefix.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits[list.length > MAX_ARRAY_LENGTH]#0',
    probedIn: APPROVAL_LIST_LIMITS,
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits[entry.length > MAX_STRING_LENGTH]#0',
    probedIn: APPROVAL_LIST_LIMITS,
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits[entry.id.length > MAX_STRING_LENGTH]#0',
    probedIn: APPROVAL_LIST_LIMITS,
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits[entry.title.length > MAX_STRING_LENGTH]#0',
    probedIn: APPROVAL_LIST_LIMITS,
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:failVisiblyIfCardIsOnScreen[wireStringSize(toolCallId) > MAX_TOOL_ID_LENGTH]#0',
    probedIn: null,
    why:
      "`failVisiblyIfCardIsOnScreen`'s cap is defense-in-depth on an input that cannot occur: " +
      '`turnToolPartIds` is only ever written after the same cap passed, so the second ' +
      'disjunct (`!turnToolPartIds.has(id)`) already rejects every over-cap id. Relaxing this ' +
      'clause alone changes no outcome (measured, 4822/4822). Previously mis-attributed to ' +
      '`closeReasoningPart` by the line-based scan, which named the last declaration it had ' +
      'seen rather than the enclosing one.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[wireStringSize(toolCallId) > MAX_TOOL_ID_LENGTH]#0',
    probedIn: null,
    why: 'tool-call id cap; pinned by studioBackendAdapter.test.ts (killed by 5 tests).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[wireStringSize(toolName) > MAX_TOOL_ID_LENGTH]#0',
    probedIn: null,
    why: 'tool NAME cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[wireStringSize(rawOutput) > outputAllowance]#0',
    probedIn: null,
    why:
      'the per-call / per-turn tool-OUTPUT size cap (`outputAllowance`), pinned by ' +
      "studioBackendAdapter.test.ts's tool-output budget tests. Same wire boundary and same " +
      'persisted sink as the approval caps beside it; invisible to the previous scan purely ' +
      'because the budget arrives as a variable rather than a named constant.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[wireStringSize(value) <= MAX_STRING_LENGTH]#0',
    probedIn: null,
    why: 'metadata string-VALUE cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[wireStringSize(key) <= MAX_METADATA_KEY_LENGTH]#0',
    probedIn: null,
    why: 'metadata KEY cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[wireValueSize(value) <= MAX_STRING_LENGTH]#0',
    probedIn: null,
    why: 'metadata non-string VALUE cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[wireStringSize(approvalToolCallId) > MAX_TOOL_ID_LENGTH]#0',
    probedIn: null,
    why: 'approval tool-call id cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[wireStringSize(approvalToolName) > MAX_TOOL_ID_LENGTH]#0',
    probedIn: null,
    why: 'approval tool NAME cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[wireStringSize(approvalId) > MAX_TOOL_ID_LENGTH]#0',
    probedIn: null,
    why: 'approval id cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/useChatThreads.ts:deriveThreadName[text.length > MAX_DERIVED_THREAD_NAME_LENGTH]#0',
    probedIn: null,
    why:
      'display truncation of a DERIVED thread name, not an admission check on a payload — the ' +
      'over-cap branch produces an ellipsized name rather than rejecting. Pinned by ' +
      'useChatThreads.test.ts.',
  },

  // ── x-studio/chat, limit-side: the PER-TURN budgets. Every row below bounds total
  //    persisted bytes or parts across a whole response, and NONE of them was enumerated
  //    while the per-string caps they back up sat two rows up as flagship inventory entries.
  {
    site: 'x-studio/chat/autoSubmit.tsx:attempt[attempts < MAX_AUTO_SUBMIT_ATTEMPTS]#0',
    probedIn: null,
    why:
      'retry cap on the auto-submit loop — a counter, so invisible to the measurement side. ' +
      'Pinned (measured: relaxing it is killed by 1 test, `--project x-studio autoSubmit`, ' +
      '7 tests).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:canAffordMessagePart[turnMessageParts < MAX_TURN_MESSAGE_PARTS]#0',
    probedIn: null,
    why:
      'the per-TURN cap on total message parts, backing up the per-KIND `subLimit` on the same ' +
      'line. Both operands are running counters. Pinned (measured: killed by 2 tests).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[toolInputSize > MAX_TOOL_INPUT_SIZE]#0',
    probedIn: null,
    why:
      'per-CALL tool-argument size. The measurement (`wireValueSize`) is hoisted into a `const` ' +
      'one statement up, which is the whole reason this and the seven rows below were ' +
      'invisible: `wireValueSize` is in `SIZE_CALLS`, it just was not inside the comparison. ' +
      'Pinned (measured: killed).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[turnToolInputSize + toolInputSize > MAX_TURN_TOOL_INPUT_SIZE]#0',
    probedIn: null,
    why:
      'the per-TURN tool-argument budget backing up the row above: individually-legal calls ' +
      'still sum. Pinned (measured: killed).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[turnMetadataKeys < MAX_ARRAY_LENGTH]#0',
    probedIn: null,
    why: 'per-TURN metadata KEY-COUNT budget, on a counter. Pinned (measured: killed by 2 tests).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[turnMetadataSize + entrySize <= MAX_TURN_METADATA_SIZE]#0',
    probedIn: null,
    why:
      'per-TURN metadata BYTE budget, charged in JSON characters. Its `||`-siblings on the ' +
      'same `if` — the per-key and per-value caps — are inventoried rows; this one was not. ' +
      'Pinned (measured: killed).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[turnApprovalSize + effectsSize <= MAX_TURN_APPROVAL_SIZE]#0',
    probedIn: null,
    why:
      'the per-TURN approval-summary budget — the exact bound that masked ' +
      "`isWithinApprovalListLimits`'s `entry.id` clause for months, and the reason " +
      "`expectClauseIsolated`'s minimality check exists. It was not itself enumerated. " +
      'Pinned (measured: killed).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[reasonSize > MAX_STRING_LENGTH]#0',
    probedIn: null,
    why: 'per-approval `reason` length, on a hoisted measurement. Pinned (measured: killed).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[turnApprovalSize + reasonSize > MAX_TURN_APPROVAL_SIZE]#0',
    probedIn: null,
    why:
      'the per-TURN half of the same budget: `reason` and `effects` share one allowance. ' +
      'Pinned (measured: killed).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[approvalInputSize <= MAX_APPROVAL_INPUT_SIZE]#0',
    probedIn: null,
    why:
      'per-approval tool-INPUT size. One of the two named limits that had no inventory row at ' +
      'all under the measurement-side scan. Pinned (measured: killed).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent[turnApprovalInputSize + approvalInputSize <= MAX_TURN_APPROVAL_INPUT_SIZE]#0',
    probedIn: null,
    why: 'the per-TURN half of the approval-input budget. Pinned (measured: killed).',
  },

  // ── x-studio-data-middleware: the request boundary and its own shared limits ──
  {
    site: 'x-studio-data-middleware/handler.ts:mapWithConcurrency[index >= items.length]#0',
    probedIn: null,
    why:
      'NOT A CAP. `index >= items.length` is the exhaustion test of a work-queue worker — the ' +
      'size is the LIMIT here rather than the measured quantity, the same shape a `for` ' +
      'condition has (and `for` conditions are excluded structurally). Listed for the same ' +
      'reason as `autoSubmit.tsx:attempt#0`: over-approximating is what stops a real cap ' +
      'written against a variable from being silently dropped.',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:checkSemiJoinBounds[filters.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR]#0',
    probedIn: null,
    why: 'semi-join filter-count cap; pinned by the handler tests.',
  },

  // ── x-studio-data-middleware, limit-side: the AGGREGATE bounds. Each of the four below
  //    exists BECAUSE the per-array cap it backs up is not enough, and each says so in its
  //    own error message ("may individually stay under its per-array cap yet still sum to an
  //    unbounded number…"). The per-array caps were inventoried rows; these were not.
  {
    site: 'x-studio-data-middleware/handler.ts:checkSemiJoinBounds[entryCount.total > MAX_ARRAY_ITEMS_PER_DESCRIPTOR]#0',
    probedIn: null,
    why:
      'aggregate cap on TOTAL semiJoins entries across every nesting level, backing up ' +
      '`semiJoins.length` at each level. `entryCount.total += semiJoins.length` sits one ' +
      'statement above the comparison, which is why no measurement-side scan could see it. ' +
      'Pinned (measured: relaxing it is killed).',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:checkSemiJoinBounds[filterCount.total > MAX_ARRAY_ITEMS_PER_DESCRIPTOR]#0',
    probedIn: null,
    why:
      'aggregate cap on TOTAL semi-join predicate objects, backing up the ' +
      '`filters.length` row above it. Pinned (measured: killed).',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:assertValidBatchQueryRequest[predicateValueCount.total > MAX_PREDICATE_VALUES_PER_DESCRIPTOR]#0',
    probedIn: null,
    why:
      'aggregate cap on TOTAL filter comparison values per widget. ' +
      '`MAX_PREDICATE_VALUES_PER_DESCRIPTOR` is one of the two named limits that had no ' +
      'inventory row anywhere under the measurement-side scan — it is only ever enforced ' +
      'against a running total, here and in `handleMutation.ts`. Pinned (measured: killed by ' +
      '2 tests).',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:assertValidBatchQueryRequest[totalOnPairs > MAX_ARRAY_ITEMS_PER_DESCRIPTOR]#0',
    probedIn: null,
    why:
      'aggregate cap on TOTAL join `on` pairs across all joins, backing up the per-join ' +
      '`on.length` row above. Pinned (measured: killed).',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:assertValidBatchQueryRequest[body.widgets.length > MAX_WIDGETS_PER_BATCH]#0',
    probedIn: null,
    why: 'widgets-per-batch cap; pinned by the handler tests.',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:assertValidBatchQueryRequest[value.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR]#0',
    probedIn: null,
    why: 'array-items-per-descriptor cap; pinned by the handler tests.',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:assertValidBatchQueryRequest[on.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR]#0',
    probedIn: null,
    why: 'join `on`-clause count cap; pinned by the handler tests.',
  },
  {
    site: 'x-studio-data-middleware/mutations/handleMutation.ts:assertValidBatchMutationRequest[body.mutations.length > MAX_MUTATIONS_PER_BATCH]#0',
    probedIn: null,
    why: 'mutations-per-batch cap; pinned by the mutation handler tests.',
  },
  {
    site: 'x-studio-data-middleware/mutations/handleMutation.ts:assertValidBatchMutationRequest[where.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR]#0',
    probedIn: null,
    why: 'where-clause count cap; pinned by the mutation handler tests.',
  },
  {
    site: 'x-studio-data-middleware/mutations/handleMutation.ts:assertValidBatchMutationRequest[totalPredicateValues.total > MAX_PREDICATE_VALUES_PER_DESCRIPTOR]#0',
    probedIn: null,
    why:
      'the mutation-side half of the aggregate predicate-value cap; the only other enforcement ' +
      'of `MAX_PREDICATE_VALUES_PER_DESCRIPTOR`, also against a running total. Pinned ' +
      '(measured: killed).',
  },
  {
    site: 'x-studio-data-middleware/security/canonicalize.ts:sortedStringify[depth > MAX_SORTED_STRINGIFY_DEPTH]#0',
    probedIn: null,
    why:
      'recursion-depth bound of the cache-key/policy-digest serializer, on a counter parameter. ' +
      'Pinned (measured: killed by 2 tests).',
  },
  {
    site: 'x-studio-data-middleware/security/validateQueryPlan.ts:validateSemiJoins[depth > MAX_SEMI_JOIN_DEPTH]#0',
    probedIn: null,
    why:
      'semi-join NESTING depth bound — each level is another subquery to allowlist-check. On a ' +
      'counter parameter. Pinned (measured: killed).',
  },
  {
    site: 'x-studio-data-middleware/security/cacheKey.ts:computeSecurityHash[securityHashMemo.size >= SECURITY_HASH_MEMO_MAX_SIZE]#0',
    probedIn: null,
    why:
      'security-hash memo eviction cap on a Map `.size`; pinned (measured: relaxing it is ' +
      'killed by 1 test). Invisible to the previous scan, which matched `.length` and ' +
      '`.byteLength` but not `.size`.',
  },
  {
    site: 'x-studio-data-middleware/shared/columnValidation.ts:assertIdentifierLength[value.length > MAX_STRING_LENGTH]#0',
    probedIn: null,
    why: 'identifier length cap; pinned by columnValidation tests (killed by 2 tests).',
  },
  {
    site: 'x-studio-data-middleware/shared/columnValidation.ts:validateAggregationAliases[agg.alias.length > MAX_STRING_LENGTH]#0',
    probedIn: null,
    why: 'aggregation-alias length cap; pinned by columnValidation tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:checkPredicateValueBounds[predicateValue.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR]#0',
    probedIn: null,
    why: 'predicate-value array cap; pinned by requestShapeGuards tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:checkPredicateValueBounds[v.length > maxStringValueLength]#0',
    probedIn: null,
    why:
      'the predicate-value STRING-LENGTH cap, whose in-function sibling (#0, the array cap) ' +
      'was already inventoried while this one was invisible — the "one sentence about N ' +
      'things, a test for N-1" shape, inside the enumeration built to break it. Pinned ' +
      '(measured: relaxing it is killed by 3 tests). The bound arrives as a parameter.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:assertIdAndTableLength[value.length > MAX_STRING_LENGTH]#0',
    probedIn: null,
    why: 'id/table-name length cap; pinned by requestShapeGuards tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:assertBoundedObjectField[entries.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR]#0',
    probedIn: null,
    why: 'object entry-count cap; pinned by requestShapeGuards tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:assertBoundedObjectField[key.length > MAX_STRING_LENGTH]#0',
    probedIn: null,
    why: 'object KEY length cap; pinned by requestShapeGuards tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:assertBoundedObjectField[entryValue.length > valueLengthLimit]#0',
    probedIn: null,
    why:
      'object VALUE length cap — the THIRD of three caps on consecutive `if`s in this ' +
      'function, of which the previous scan could see the first two. Pinned (measured: ' +
      'relaxing it is killed by 2 tests). The bound arrives as a parameter.',
  },
];

/** The sites whose two-direction probe is claimed to live in `testFile`. */
export function sitesProbedIn(testFile: string): string[] {
  return SIZE_CAP_INVENTORY.filter((entry) => entry.probedIn === testFile).map(
    (entry) => entry.site,
  );
}
