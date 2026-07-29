/**
 * Shared request-shape bound checks for @mui/x-studio-data-middleware.
 *
 * The read path's `handler.ts` (`assertValidBatchQueryRequest`) and the write
 * path's `mutations/handleMutation.ts` (`assertValidBatchMutationRequest`) both
 * validate a client-supplied batch of descriptors before touching them, and
 * three of those checks are the SAME algorithm applied to differently-named
 * fields (a predicate array's value-bound check, an id/table length check, and
 * a plain-object field's shape+key-count+entry-length check) rather than three
 * genuinely different rules. Each was previously reimplemented inline at both
 * call sites — this module is the one place each algorithm lives.
 *
 * Every function here is parameterized on WHERE it was called from (a
 * `DescriptorRef`) and on the specific wording each call site's error needs, so
 * consolidating the algorithm does not flatten the two callers' error text into
 * one generic message. The read path's filters/columnAliases are folded into
 * the query cache key (`security/cacheKey.ts`) and reused across requests; the
 * write path's where-predicates/values are not (mutation results are
 * invalidated by TABLE TAG, never by key) — that distinction is real, not
 * incidental duplication, so it stays expressed in the message text via the
 * options below rather than being genericized away.
 */
import { MAX_ARRAY_ITEMS_PER_DESCRIPTOR, MAX_STRING_LENGTH } from './limits';

/**
 * Identifies where a validation error occurred, for the two batch request
 * shapes this module serves.
 */
export interface DescriptorRef {
  /** The noun naming this kind of descriptor, e.g. `'widget'` or `'mutation'`. */
  noun: string;
  /** Where this descriptor lives in the batch, e.g. `` `widgets[${index}]` `` or `` `mutations[${index}]` ``. */
  location: string;
}

/** Build the `"Malformed <noun> descriptor at <location> — "` prefix shared by every error this module throws. */
function descriptorPrefix(ref: DescriptorRef): string {
  return `MUI X Studio Server: Malformed ${ref.noun} descriptor at ${ref.location} — `;
}

/**
 * Enforce both value-size bounds on ONE predicate array — the read path's
 * `filters`/`semiJoins[].filters`, or the write path's `where` — the IDENTICAL
 * algorithm both `handler.ts` and `mutations/handleMutation.ts` used to
 * reimplement inline: counts `in`/`between` values, caps per-list length
 * against `MAX_ARRAY_ITEMS_PER_DESCRIPTOR`, caps each string against
 * `MAX_STRING_VALUE_LENGTH`, accumulates a running total into the caller's
 * shared `valueCount` accumulator so a summed cap (`MAX_PREDICATE_VALUES_PER_DESCRIPTOR`)
 * can span every predicate array in one descriptor, not just one of them.
 *
 * `predicates.value` is NOT shape-validated here (that happens later, per
 * descriptor, in `shared/predicates.ts` / `mutationBuilder.ts`); only a
 * PRESENT array/string value is bounds-checked, regardless of operator, so a
 * pathological `in`-list or value string cannot reach query building at all.
 *
 * @param predicates - The candidate predicate array (ignored when not an
 *   array — the array-shape rejection is the caller's, with its own message).
 * @param ref - The descriptor this predicate array belongs to.
 * @param path - Where this array lives on the descriptor, e.g. `filters`,
 *   `where`, or `semiJoins[0].semiJoins[1].filters`.
 * @param valueCount - Shared, mutable running total of comparison values.
 * @param options.arrayLengthCostPhrase - Completes "An unbounded \"in\" value
 *   list is unbounded <phrase> driven entirely by client input." — the read
 *   path's filters feed both query building AND execution; the write path's
 *   where-predicates, validated here before a builder ever runs, feed only
 *   query building.
 * @param options.maxStringValueLength - The string-value length ceiling
 *   (`MAX_STRING_VALUE_LENGTH`), threaded in rather than imported directly so
 *   this module has no dependency on which value-bound constant a caller uses.
 * @param options.valueEntersCacheKeyHash - Whether the string-length error
 *   should note that an oversized value is folded into the query cache key —
 *   true only for the read path, whose filters ARE cache-keyed.
 */
export function checkPredicateValueBounds(
  predicates: unknown,
  ref: DescriptorRef,
  path: string,
  valueCount: { total: number },
  options: {
    arrayLengthCostPhrase: string;
    maxStringValueLength: number;
    valueEntersCacheKeyHash: boolean;
  },
): void {
  if (!Array.isArray(predicates)) {
    return;
  }
  const { arrayLengthCostPhrase, maxStringValueLength, valueEntersCacheKeyHash } = options;
  predicates.forEach((predicate, predicateIndex) => {
    const predicateValue = (predicate as { value?: unknown } | null)?.value;
    // Count real comparison values: every element of an `in`/`between` list, or
    // one for a present scalar. An absent `value` contributes nothing.
    if (Array.isArray(predicateValue)) {
      valueCount.total += predicateValue.length;
    } else if (predicateValue !== undefined) {
      valueCount.total += 1;
    }
    if (Array.isArray(predicateValue) && predicateValue.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
      throw new Error(
        `${descriptorPrefix(ref)}"${path}[${predicateIndex}].value" ` +
          `contains ${predicateValue.length} entries, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} ` +
          `allowed per predicate. An unbounded "in" value list is unbounded ${arrayLengthCostPhrase} ` +
          `driven entirely by client input. Reduce the number of entries to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
      );
    }
    // Length cap on a scalar/"in"-element STRING value (Tier2 finding — resource
    // exhaustion). Uses the larger value-length bound (not the identifier
    // bound): a predicate value is business data, not an identifier, and may
    // legitimately need more headroom.
    const stringValues = Array.isArray(predicateValue) ? predicateValue : [predicateValue];
    stringValues.forEach((v) => {
      if (typeof v === 'string' && v.length > maxStringValueLength) {
        throw new Error(
          `${descriptorPrefix(ref)}"${path}[${predicateIndex}].value" ` +
            `contains a string ${v.length} characters long, which exceeds the maximum of ${maxStringValueLength} ` +
            `allowed. An unbounded value string is expensive to hash${valueEntersCacheKeyHash ? ' (it is folded into the query cache key)' : ''} and, ` +
            `once queried, expensive for the database to scan/index as a bound parameter. Shorten the value to at ` +
            `most ${maxStringValueLength} characters.`,
        );
      }
    });
  });
}

/**
 * Enforce `MAX_STRING_LENGTH` on a descriptor's `id` and `table` fields — the
 * IDENTICAL four-line loop `handler.ts` and `mutations/handleMutation.ts` used
 * to each reimplement, both already confirmed to be strings by their caller's
 * own object-shape check just before this runs.
 *
 * @param ref - The descriptor this id/table pair belongs to.
 * @param fields - The `[fieldName, value]` pairs to check, in the order they
 *   should be reported (conventionally `id` then `table`).
 * @param costVerb - Completes "An unbounded \"<field>\" string is expensive to
 *   <verb> and serialize repeatedly across a batch." — the read path hashes
 *   both fields (a widget `table` is re-hashed into the cache key on every
 *   request); the write path never computes a cache key at all, so its cost is
 *   validating the field repeatedly, not hashing it.
 */
export function assertIdAndTableLength(
  ref: DescriptorRef,
  fields: readonly (readonly [string, string])[],
  costVerb: string,
): void {
  for (const [field, value] of fields) {
    if (value.length > MAX_STRING_LENGTH) {
      throw new Error(
        `${descriptorPrefix(ref)}"${field}" is ${value.length} ` +
          `characters long, which exceeds the maximum of ${MAX_STRING_LENGTH} allowed. ` +
          `An unbounded "${field}" string is expensive to ${costVerb} and serialize repeatedly across a batch. ` +
          `Shorten "${field}" to at most ${MAX_STRING_LENGTH} characters.`,
      );
    }
  }
}

/**
 * Configuration for `assertBoundedObjectField` — every piece of wording that
 * legitimately differs between the read path's `columnAliases` (a map of
 * logical field id → physical column reference, where BOTH sides are
 * identifiers) and the write path's `values` (a map of column name → data
 * being written, where only the key is an identifier).
 */
export interface BoundedObjectFieldOptions {
  /** The field name as it appears on the wire, e.g. `'columnAliases'` or `'values'`. */
  fieldName: string;
  /** The descriptor this field belongs to. */
  ref: DescriptorRef;
  /** Noun used in the key-count cap's "... allowed per <noun>." clause, e.g. `'widget'` or `'mutation'`. */
  perDescriptorNoun: string;
  /**
   * Whether every value must ALSO be a string for the object to pass the shape
   * check — true for `columnAliases` (a map to column references), false for
   * `values` (a map to arbitrary column data, checked for string length only
   * where a value happens to be a string).
   */
  requireStringValues: boolean;
  /** Completes "... must be a plain object <phrase>, but received ...". */
  shapeDescription: string;
  /** Completes "A non-object ... <phrase>." describing what an invalid shape would otherwise do. */
  invalidShapeConsequence: string;
  /** The full corrective sentence closing the shape error, e.g. `Ensure "columnAliases" is a { [logicalId: string]: string } object (or omit it).`. */
  shapeCorrectiveInstruction: string;
  /** Completes "An unbounded number of ... is unbounded <phrase> driven entirely by client input." for the key-count cap. */
  keyCountConsequence: string;
  /** Completes "An unbounded key is expensive to <phrase>." for the per-key length cap. */
  keyLengthConsequence: string;
  /** The length ceiling applied to each VALUE — `MAX_STRING_LENGTH` (an identifier bound) for `columnAliases`, `MAX_STRING_VALUE_LENGTH` (a data bound) for `values`. */
  valueLengthLimit: number;
  /** Whether the value-length ceiling is an identifier bound (adds "allowed for an identifier" instead of just "allowed"). */
  valueLengthIsIdentifierBound: boolean;
  /** Completes "An unbounded value ... <phrase>." for the per-value length cap. */
  valueLengthConsequence: string;
  /** Whether the value-length error's closing sentence names the offending key (`values`) or not (`columnAliases`, which already names it earlier in the message). */
  valueShortenMentionsKey: boolean;
}

/**
 * Validate a client-supplied PLAIN-OBJECT descriptor field — the read path's
 * `columnAliases`, or the write path's `values` — the IDENTICAL algorithm
 * `handler.ts` and `mutations/handleMutation.ts` used to each reimplement:
 * reject a non-plain-object (or, when `requireStringValues`, one with a
 * non-string value), cap the key count against
 * `MAX_ARRAY_ITEMS_PER_DESCRIPTOR`, then cap every key's length against
 * `MAX_STRING_LENGTH` and every (string) value's length against
 * `options.valueLengthLimit`.
 *
 * @param value - The candidate field value. `undefined` is a no-op — both
 *   callers treat this field as optional and check presence themselves.
 * @param options - See `BoundedObjectFieldOptions` for what varies per caller.
 */
export function assertBoundedObjectField(value: unknown, options: BoundedObjectFieldOptions): void {
  if (value === undefined) {
    return;
  }
  const {
    fieldName,
    ref,
    perDescriptorNoun,
    requireStringValues,
    shapeDescription,
    invalidShapeConsequence,
    shapeCorrectiveInstruction,
    keyCountConsequence,
    keyLengthConsequence,
    valueLengthLimit,
    valueLengthIsIdentifierBound,
    valueLengthConsequence,
    valueShortenMentionsKey,
  } = options;

  const isMisshapen =
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (requireStringValues && Object.values(value).some((v) => typeof v !== 'string'));
  if (isMisshapen) {
    throw new Error(
      `${descriptorPrefix(ref)}"${fieldName}" must be a plain ${shapeDescription}, but received ` +
        `${JSON.stringify(value)}. ${invalidShapeConsequence} ${shapeCorrectiveInstruction}`,
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) {
    throw new Error(
      `${descriptorPrefix(ref)}"${fieldName}" contains ` +
        `${entries.length} keys, which exceeds the maximum of ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR} allowed per ` +
        `${perDescriptorNoun}. ${keyCountConsequence} ` +
        `Reduce the number of keys in "${fieldName}" to at most ${MAX_ARRAY_ITEMS_PER_DESCRIPTOR}.`,
    );
  }

  const identifierSuffix = valueLengthIsIdentifierBound ? ' allowed for an identifier' : ' allowed';
  for (const [key, entryValue] of entries) {
    if (key.length > MAX_STRING_LENGTH) {
      throw new Error(
        `${descriptorPrefix(ref)}a "${fieldName}" key is ` +
          `${key.length} characters long, which exceeds the maximum of ${MAX_STRING_LENGTH} allowed for an ` +
          `identifier. ${keyLengthConsequence} Shorten the "${fieldName}" key to at most ${MAX_STRING_LENGTH} characters.`,
      );
    }
    // `columnAliases` already guaranteed every value is a string above (via
    // `requireStringValues`); `values` did not, so the `typeof` guard here is
    // what confines the length cap to actual string values on that path —
    // a non-string `values` entry (a number, boolean, …) is left to the
    // mutation builder, which validates it against the target column's type.
    if (typeof entryValue === 'string' && entryValue.length > valueLengthLimit) {
      const shortenTarget = valueShortenMentionsKey
        ? `"${fieldName}" value for "${key}"`
        : `"${fieldName}" value`;
      throw new Error(
        `${descriptorPrefix(ref)}"${fieldName}" value for key ` +
          `"${key.slice(0, 80)}…" is ${entryValue.length} characters long, which exceeds the maximum of ` +
          `${valueLengthLimit}${identifierSuffix}. ${valueLengthConsequence} Shorten the ${shortenTarget} ` +
          `to at most ${valueLengthLimit} characters.`,
      );
    }
  }
}
