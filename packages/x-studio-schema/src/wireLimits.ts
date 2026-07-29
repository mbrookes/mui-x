/**
 * Shared wire trust-boundary size caps.
 *
 * Deliberately generous, conservative caps — far beyond anything a real
 * dashboard-editing UI or AI tool call would ever approach — not tight limits tuned to an
 * exact legitimate maximum. Exported so every "is this array/string too large to be a
 * legitimate payload" check in the package enforces the SAME threshold: `parseStateMutation.ts`
 * (the wire boundary) and `internalGuards.ts`'s `repairFilterDependsOn` (the reducer/load
 * boundaries' defense-in-depth repair, reachable by server-built mutations and persisted docs
 * that never pass through the wire boundary) both cap against these, so a payload that is
 * bounded on one path cannot be unbounded on the other.
 *
 * Zero-dependency by design (mirrors `unsafeKeys.ts`) so both `parseStateMutation.ts` and
 * `internalGuards.ts` can import from here without forming an import cycle.
 */
export const MAX_ARRAY_LENGTH = 500;
export const MAX_STRING_LENGTH = 10_000;
