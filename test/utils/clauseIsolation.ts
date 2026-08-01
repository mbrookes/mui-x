import { expect } from 'vitest';

/**
 * Prove that a fixture actually REACHES the clause it is named for — and that no sibling
 * clause is the one doing the rejecting.
 *
 * ── The defect this exists to make impossible ──
 *
 * A table-driven pin can answer "does every clause have a test row?" and still be worth
 * nothing, because it cannot answer the next question: **does the row's payload reach the
 * clause?** Two measured examples from this codebase, both of which passed for months:
 *
 *  - `extractSecurityClaims.test.ts` had a four-test block written for the
 *    `!Number.isFinite(payload.exp)` clause, including one named `rejects a NaN "exp"
 *    claim`. Its helper serialises the payload with `JSON.stringify`, and
 *    `JSON.stringify({ exp: NaN })` is `{"exp":null}` — so the value that arrived at the
 *    guard was `null`, which the PRECEDING `typeof payload.exp !== 'number'` clause
 *    already rejects. Delete the `Number.isFinite` clause and all four tests stay green,
 *    while `{"exp":1e999}` (valid JSON, parses to `Infinity`) buys a signed token that
 *    never expires.
 *  - `processStream.test.ts` had a test titled `deduplicates repeated event ids …` that
 *    sends the same `eventId` twice — with the same `sequence` both times, by which point
 *    the stale-sequence guard beside it already drops the duplicate. Delete the eventId
 *    dedup and the test stays green while `"Hello"` replays as `"HelloHello"`.
 *
 * Both are the same shape: a test named after a clause, satisfied by its neighbour. Neither
 * is visible by reading the test — the encoding that defeats the first is two frames away
 * in a helper, and the sibling that satisfies the second is in a different file. The only
 * thing that found them was mutating the clause and watching its own test stay green.
 *
 * ── What this asserts, and why that is the same question ──
 *
 * A test author states the guard's clauses as predicates over the value **as the guard sees
 * it**, then supplies two payloads. `expectClauseIsolated` asserts:
 *
 *  1. no clause rejects `control` — so the guard as a whole admits the baseline, and
 *     "rejects everything" cannot pass;
 *  2. `target` rejects `violating` — so the payload does reach the clause;
 *  3. NO OTHER clause rejects `violating` — so the clause is the only thing that can be
 *     answering, which is precisely what a surviving mutant of it would disprove.
 *
 * (3) is the new one and the one that matters. Feed it `exp: NaN` and it fails on the spot,
 * naming `typeof number` as the clause that really rejects — the author does not have to
 * notice anything.
 *
 * ── What it deliberately does NOT do ──
 *
 * It does not replace running the boundary. `observed` is read back from the payload
 * downstream of every encoding in between (decode the JWT, read the envelope the stream
 * loop sees), and the test still calls the real function and asserts the real outcome. This
 * says WHY the outcome happened; the call says THAT it happened.
 *
 * It also does not verify that the transcribed predicates match the source. That is a
 * reviewable, local claim sitting beside the clause it quotes — unlike a `JSON.stringify`
 * in a helper, which is neither.
 */
export interface ClauseIsolation<TObserved> {
  /** What the guard is, for the failure message. Usually `file.ts:functionName`. */
  guard: string;
  /**
   * The guard's clauses, in source order, keyed by a label that quotes the source:
   * `'typeof payload.exp !== "number"'`. Each returns TRUE when that clause REJECTS.
   */
  clauses: Record<string, (observed: TObserved) => boolean>;
  /** Which clause this fixture exists to exercise. Must be a key of {@link clauses}. */
  target: string;
  /**
   * The baseline value the guard must ADMIT, as the guard sees it. Without it, a predicate
   * set that rejects everything would satisfy the other two assertions.
   */
  control: TObserved;
  /**
   * The value the fixture actually delivers to the guard — read back downstream of every
   * encoding between the test author and the clause, never the literal that was typed.
   * This is the whole point: `exp: NaN` must be read back off the encoded token, where it
   * is `null`.
   */
  observed: TObserved;
}

function rejectingClauses<T>(clauses: Record<string, (v: T) => boolean>, value: T): string[] {
  return Object.keys(clauses).filter((label) => clauses[label](value));
}

/**
 * Assert that {@link ClauseIsolation.observed} is rejected by
 * {@link ClauseIsolation.target} and by nothing else in the same guard.
 */
export function expectClauseIsolated<T>(isolation: ClauseIsolation<T>): void {
  const { guard, clauses, target, control, observed } = isolation;

  if (!Object.hasOwn(clauses, target)) {
    throw new Error(
      `expectClauseIsolated: "${target}" is not one of ${guard}'s clauses ` +
        `(${Object.keys(clauses).join(', ')}). The target names the clause under test, so a ` +
        'typo here would silently assert nothing.',
    );
  }

  const rejectsControl = rejectingClauses(clauses, control);
  expect(
    rejectsControl,
    `${guard}: the control payload must be admitted by every clause, or the fixture proves ` +
      `nothing about ${target} — a guard that rejects everything would pass too. Rejected by: ` +
      `${rejectsControl.join(', ')}.`,
  ).toEqual([]);

  const rejectsObserved = rejectingClauses(clauses, observed);
  expect(
    rejectsObserved,
    `${guard}: this fixture is named for ${target}, but the value that actually reaches the ` +
      `guard — ${JSON.stringify(observed)} — is rejected by [${rejectsObserved.join(', ')}]. ` +
      'A test satisfied by a sibling clause stays green when the clause it names is deleted. ' +
      'Either the payload does not survive the encoding between here and the guard, or the ' +
      'target is wrong.',
  ).toEqual([target]);
}
