import { expect } from 'vitest';

/**
 * Evidence that a fixture REACHES the clause it is named for — and that none of the other
 * rejectors the author could think of is the one doing the rejecting.
 *
 * ── The defect this exists to make harder ──
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
 * Both are the same shape: a test named after a clause, satisfied by something else. Neither
 * is visible by reading the test — the encoding that defeats the first is two frames away
 * in a helper, and the rejector that satisfies the second is in a different file. The only
 * thing that found them was mutating the clause and watching its own test stay green.
 *
 * ── What this asserts ──
 *
 * A test author states the rejectors it can see as predicates over the value **as the guard
 * sees it**, then supplies two payloads. `expectClauseIsolated` asserts:
 *
 *  1. no listed predicate rejects `control` — so the baseline is admitted, and a predicate
 *     set that "rejects everything" cannot pass;
 *  2. `target` rejects `observed` — so the payload does reach the clause;
 *  3. no OTHER LISTED predicate rejects `observed`;
 *  4. for a {@link BoundIsolation}, `observed` is the MINIMAL violation — exactly one unit
 *     past `control` on the dimension the clause bounds.
 *
 * (2) catches the `exp: NaN` fixture on the spot, naming `typeof number` as the clause that
 * really rejects. (4) is what catches a masking bound the author never listed; see below.
 *
 * ── What it does NOT establish, and why no transcription could ──
 *
 * **`clauses` is a human-supplied list of the rejectors the author thought of. Nothing here
 * checks that it is complete.** An earlier version of this docblock claimed (3) meant "the
 * clause is the only thing that can be answering, which is precisely what a surviving mutant
 * of it would disprove". That was false, and measurably so:
 *
 *   `studioBackendAdapter.test.ts`'s `isWithinApprovalListLimits#2` fixture, with the `id`
 *   grown from `MAX_STRING_LENGTH + 1` to `6 * MAX_STRING_LENGTH`, satisfies (1), (2) and
 *   (3); both directions of its two-direction pin still pass; and a token-preserving mutant
 *   of the clause it names SURVIVES the whole 4837-test project. `MAX_TURN_APPROVAL_SIZE`,
 *   in a different function ~1400 lines away, sets the identical `effectsWithheld: true`.
 *
 * The quantifier is the bug. (3) ranges over the listed predicates; the conclusion ranges
 * over every bound on the payload's path to the observable. Closing that gap needs a claim
 * about the whole program, and no list a human transcribes beside one guard is that. It is
 * not a FIDELITY problem — the transcriptions here are accurate — it is a COMPLETENESS
 * problem, and completeness of "every bound on this path" is exactly the question mutation
 * testing answers by execution and reading answers badly.
 *
 * So (4) exists, and it is the honest, checkable substitute. It does not prove no other
 * bound is answering. It forces the WINDOW in which another bound could hide to be one unit
 * wide instead of however wide the author's payload happened to open it: a masking bound
 * must now share the clause's threshold exactly, rather than merely sitting somewhere
 * between "at the cap" and "obviously over it". In the measured counter-example above the
 * masking bound needed a 40 000-character window, and the author supplied a 50 000-character
 * one by reaching for `6 * MAX_STRING_LENGTH` instead of `+ 1`.
 *
 * **The real guarantee, stated plainly:** a fixture that passes this reaches the clause it
 * names, is not satisfied by any rejector the author listed, and — for a bound — is the
 * tightest witness that clause has. Whether some UNLISTED rejector elsewhere produces the
 * same observable is not decided here and cannot be. Only relaxing the clause and re-running
 * the suite decides it. This says WHY the outcome plausibly happened; running the boundary
 * says THAT it happened; a surviving mutant is the only thing that says the clause is dead.
 */

interface ClauseIsolationBase<TObserved> {
  /** What the guard is, for the failure message. Usually `file.ts:functionName`. */
  guard: string;
  /**
   * The rejectors the author can see, keyed by a label that quotes the source:
   * `'typeof payload.exp !== "number"'`. Each returns TRUE when that predicate REJECTS.
   *
   * Not required to be the clauses of one function — list anything on the payload's path
   * that could plausibly reject it, including guards in other files. The more of the path
   * this covers the more (3) is worth; nothing checks that it covers all of it.
   */
  clauses: Record<string, (observed: TObserved) => boolean>;
  /** Which clause this fixture exists to exercise. Must be a key of {@link clauses}. */
  target: string;
  /**
   * The baseline value the guard must ADMIT, as the guard sees it. Without it, a predicate
   * set that rejects everything would satisfy the other assertions.
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

/**
 * A clause that bounds a MEASURABLE dimension — a length, a byte count, an item count, a
 * nesting depth. `observed` must be exactly one unit past `control` on that dimension.
 */
export interface BoundIsolation<TObserved> extends ClauseIsolationBase<TObserved> {
  kind: 'bound';
  /**
   * The dimension the target clause bounds, measured on the value AS THE GUARD SEES IT —
   * `(entry) => (entry.id as string).length`, not a recomputation from the literal that was
   * typed upstream.
   *
   * This is what makes the minimality check self-checking rather than another transcribed
   * claim: it is evaluated on both payloads, so a `measure` that reads the wrong field
   * almost always fails the `+1` assertion rather than silently agreeing with itself.
   */
  measure: (observed: TObserved) => number;
}

/**
 * A clause whose violation is a SHAPE, not a size — `typeof x !== 'number'`,
 * `seen.has(id)`, `!Number.isFinite(x)`. There is no dimension to be one unit past, so
 * minimality does not apply and the author says so in writing.
 */
export interface ShapeIsolation<TObserved> extends ClauseIsolationBase<TObserved> {
  kind: 'shape';
  /**
   * Why there is no minimal violation to supply. A claim a reader can check, in the same
   * spirit as `SizeCapEntry.why` — "this clause is not a bound" is exactly the sentence a
   * `bound` fixture would use to skip the one check that catches a masking bound, so it is
   * required rather than inferred.
   */
  whyNotMinimal: string;
}

export type ClauseIsolation<TObserved> = BoundIsolation<TObserved> | ShapeIsolation<TObserved>;

function rejectingClauses<T>(clauses: Record<string, (v: T) => boolean>, value: T): string[] {
  return Object.keys(clauses).filter((label) => clauses[label](value));
}

/**
 * Assert that {@link ClauseIsolationBase.observed} is rejected by
 * {@link ClauseIsolationBase.target} and by no other LISTED predicate — and, for a
 * {@link BoundIsolation}, that it is the tightest witness the clause has.
 *
 * See the module docblock for what this does and does not establish. In particular it is
 * not a substitute for relaxing the clause and re-running the suite.
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

  if (isolation.kind === 'shape' && !isolation.whyNotMinimal.trim()) {
    throw new Error(
      `expectClauseIsolated: ${guard}'s "${target}" is declared kind: 'shape' with no ` +
        '`whyNotMinimal`. A shape fixture skips the minimality check — the one assertion ' +
        'that catches a bound in ANOTHER function producing the same observable — so the ' +
        'reason has to be written down where a reviewer can disagree with it. If the clause ' +
        "does bound a measurable dimension, use kind: 'bound' and supply `measure`.",
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

  if (isolation.kind === 'bound') {
    const controlSize = isolation.measure(control);
    const observedSize = isolation.measure(observed);
    expect(
      observedSize,
      `${guard}: the fixture for ${target} is not the MINIMAL violation — the control ` +
        `measures ${controlSize} and the violating payload measures ${observedSize}, a window ` +
        `${observedSize - controlSize} units wide. Every bound anywhere on this payload's ` +
        'path whose threshold falls inside that window rejects this payload too, produces ' +
        'the same observable, and keeps the test green with the clause under test dead — ' +
        'and this helper cannot see those, because `clauses` is only what was transcribed ' +
        'here. Measured instance: growing an `id` from MAX_STRING_LENGTH + 1 to ' +
        '6 * MAX_STRING_LENGTH let MAX_TURN_APPROVAL_SIZE, 1400 lines away, answer instead. ' +
        `Use the payload exactly one unit over the cap (${controlSize + 1}).`,
    ).toBe(controlSize + 1);
  }
}
