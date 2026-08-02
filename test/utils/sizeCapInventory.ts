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
 */
export const SIZE_CAP_INVENTORY: SizeCapEntry[] = [
  // ── x-studio-schema: the wire parser and the reducer/load-boundary repair ──
  {
    site: 'x-studio-schema/internalGuards.ts:repairFilterDependsOn#0',
    probedIn: null,
    why: 'array cap; pinned by internalGuards.test.ts (an over-long dependsOn array is stripped).',
  },
  {
    site: 'x-studio-schema/internalGuards.ts:repairFilterDependsOn#1',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue#1',
    probedIn: null,
    why: 'array cap on a nested value; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue#2',
    probedIn: null,
    why: 'record KEY-COUNT cap (MAX_RECORD_KEYS), not a string length; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue#3',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  { site: 'x-studio-schema/parseStateMutation.ts:isString#0', probedIn: BOUNDED_STRING_GUARDS },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isOptionalString#0',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  { site: 'x-studio-schema/parseStateMutation.ts:isSafeId#0', probedIn: BOUNDED_STRING_GUARDS },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isStringArray#0',
    probedIn: null,
    why: 'array cap; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isStringArray#1',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isStringMatrix#0',
    probedIn: null,
    why: 'array cap on the outer matrix; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isFiniteNumberRecord#0',
    probedIn: null,
    why: 'key-COUNT cap; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isFiniteNumberRecord#1',
    probedIn: BOUNDED_STRING_GUARDS,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:applyBulkUpdate#0',
    probedIn: null,
    why: 'array cap on addedWidgets; pinned by parseStateMutation.test.ts.',
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:applyBulkUpdate#1',
    probedIn: null,
    why: 'array cap on updatedWidgets; pinned by parseStateMutation.test.ts.',
  },

  // ── x-studio/chat: the same shared limits, enforced across the package boundary ──
  {
    site: 'x-studio/chat/autoSubmit.tsx:attempt#0',
    probedIn: null,
    why:
      'NOT A CAP. `store.state.messageIds.length > messageCountBefore` asks whether the ' +
      'submit actually appended a message; nothing is bounded and there is no threshold to ' +
      'relax. Listed because the scan deliberately over-approximates on the right operand ' +
      '(see sizeCapScan.ts): the cost of never missing a cap written against a variable is ' +
      'a handful of rows like this one.',
  },
  {
    site: 'x-studio/chat/chatTurnMutations.ts:record#0',
    probedIn: null,
    why:
      'turn-ledger retention cap on a Map `.size`; pinned by chatTurnMutations.test.ts ' +
      '(round 15). This is the cap the scan was rebuilt for: the file had no test file at ' +
      'all and the previous scan could not see a `.size` cap, so the inventory reported ' +
      'everything accounted for while this sat unpinned inside a walked directory.',
  },
  {
    site: 'x-studio/chat/generateInsight.ts:buildChartWidgetSummary#0',
    probedIn: null,
    why:
      'prompt-context TRUNCATION of a heatmap axis, not an admission check: the over-cap ' +
      'branch appends "showing first N" and the rows are sliced either way, so relaxing it ' +
      'lengthens a prompt rather than admitting a payload. Bound is a parameter (`maxRows`), ' +
      'which is why the previous name-matching scan could not see it.',
  },
  {
    site: 'x-studio/chat/richContext.ts:strideSample#0',
    probedIn: null,
    why:
      'MAX_STATS_ROWS, passed in as `max`; pinned by richContext.test.ts. Round 14 reported ' +
      'this cap as unpinned and added its file to the scan in the same commit — and the ' +
      'scan still could not see it, because the bound is an argument rather than a name.',
  },
  {
    site: 'x-studio/chat/sseUtils.ts:parseSSEStream#0',
    probedIn: null,
    why: 'SSE read-buffer cap; pinned by sseUtils.test.ts (an un-delimited stream aborts).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:truncateToWireSize#0',
    probedIn: null,
    why:
      'the fast path of a TRUNCATION helper (return the value whole when it already fits), ' +
      'not an admission check — the function returns a prefix rather than rejecting. Its ' +
      'callers are the sites that decide what the budget is, and those are inventoried ' +
      'separately. Exercised throughout studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:truncateToWireSize#1',
    probedIn: null,
    why:
      'the binary-search step of the same truncation helper: it is the LOOP INVARIANT, not a ' +
      'bound on a payload. Relaxing it does not admit more data, it returns a wrong prefix.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits#0',
    probedIn: APPROVAL_LIST_LIMITS,
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits#1',
    probedIn: APPROVAL_LIST_LIMITS,
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits#2',
    probedIn: APPROVAL_LIST_LIMITS,
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits#3',
    probedIn: APPROVAL_LIST_LIMITS,
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:failVisiblyIfCardIsOnScreen#0',
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
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent#0',
    probedIn: null,
    why: 'tool-call id cap; pinned by studioBackendAdapter.test.ts (killed by 5 tests).',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent#1',
    probedIn: null,
    why: 'tool NAME cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent#2',
    probedIn: null,
    why:
      'the per-call / per-turn tool-OUTPUT size cap (`outputAllowance`), pinned by ' +
      "studioBackendAdapter.test.ts's tool-output budget tests. Same wire boundary and same " +
      'persisted sink as the approval caps beside it; invisible to the previous scan purely ' +
      'because the budget arrives as a variable rather than a named constant.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent#3',
    probedIn: null,
    why: 'metadata string-VALUE cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent#4',
    probedIn: null,
    why: 'metadata KEY cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent#5',
    probedIn: null,
    why: 'metadata non-string VALUE cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent#6',
    probedIn: null,
    why: 'approval tool-call id cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent#7',
    probedIn: null,
    why: 'approval tool NAME cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/studioBackendAdapter.ts:processEvent#8',
    probedIn: null,
    why: 'approval id cap; pinned by studioBackendAdapter.test.ts.',
  },
  {
    site: 'x-studio/chat/useChatThreads.ts:deriveThreadName#0',
    probedIn: null,
    why:
      'display truncation of a DERIVED thread name, not an admission check on a payload — the ' +
      'over-cap branch produces an ellipsized name rather than rejecting. Pinned by ' +
      'useChatThreads.test.ts.',
  },

  // ── x-studio-data-middleware: the request boundary and its own shared limits ──
  {
    site: 'x-studio-data-middleware/handler.ts:mapWithConcurrency#0',
    probedIn: null,
    why:
      'NOT A CAP. `index >= items.length` is the exhaustion test of a work-queue worker — the ' +
      'size is the LIMIT here rather than the measured quantity, the same shape a `for` ' +
      'condition has (and `for` conditions are excluded structurally). Listed for the same ' +
      'reason as `autoSubmit.tsx:attempt#0`: over-approximating is what stops a real cap ' +
      'written against a variable from being silently dropped.',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:checkSemiJoinBounds#0',
    probedIn: null,
    why: 'semi-join filter-count cap; pinned by the handler tests.',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:assertValidBatchQueryRequest#0',
    probedIn: null,
    why: 'widgets-per-batch cap; pinned by the handler tests.',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:assertValidBatchQueryRequest#1',
    probedIn: null,
    why: 'array-items-per-descriptor cap; pinned by the handler tests.',
  },
  {
    site: 'x-studio-data-middleware/handler.ts:assertValidBatchQueryRequest#2',
    probedIn: null,
    why: 'join `on`-clause count cap; pinned by the handler tests.',
  },
  {
    site: 'x-studio-data-middleware/mutations/handleMutation.ts:assertValidBatchMutationRequest#0',
    probedIn: null,
    why: 'mutations-per-batch cap; pinned by the mutation handler tests.',
  },
  {
    site: 'x-studio-data-middleware/mutations/handleMutation.ts:assertValidBatchMutationRequest#1',
    probedIn: null,
    why: 'where-clause count cap; pinned by the mutation handler tests.',
  },
  {
    site: 'x-studio-data-middleware/security/cacheKey.ts:computeSecurityHash#0',
    probedIn: null,
    why:
      'security-hash memo eviction cap on a Map `.size`; pinned (measured: relaxing it is ' +
      'killed by 1 test). Invisible to the previous scan, which matched `.length` and ' +
      '`.byteLength` but not `.size`.',
  },
  {
    site: 'x-studio-data-middleware/shared/columnValidation.ts:assertIdentifierLength#0',
    probedIn: null,
    why: 'identifier length cap; pinned by columnValidation tests (killed by 2 tests).',
  },
  {
    site: 'x-studio-data-middleware/shared/columnValidation.ts:validateAggregationAliases#0',
    probedIn: null,
    why: 'aggregation-alias length cap; pinned by columnValidation tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:checkPredicateValueBounds#0',
    probedIn: null,
    why: 'predicate-value array cap; pinned by requestShapeGuards tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:checkPredicateValueBounds#1',
    probedIn: null,
    why:
      'the predicate-value STRING-LENGTH cap, whose in-function sibling (#0, the array cap) ' +
      'was already inventoried while this one was invisible — the "one sentence about N ' +
      'things, a test for N-1" shape, inside the enumeration built to break it. Pinned ' +
      '(measured: relaxing it is killed by 3 tests). The bound arrives as a parameter.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:assertIdAndTableLength#0',
    probedIn: null,
    why: 'id/table-name length cap; pinned by requestShapeGuards tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:assertBoundedObjectField#0',
    probedIn: null,
    why: 'object entry-count cap; pinned by requestShapeGuards tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:assertBoundedObjectField#1',
    probedIn: null,
    why: 'object KEY length cap; pinned by requestShapeGuards tests.',
  },
  {
    site: 'x-studio-data-middleware/shared/requestShapeGuards.ts:assertBoundedObjectField#2',
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
