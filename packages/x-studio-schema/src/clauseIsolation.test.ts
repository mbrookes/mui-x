import { describe, expect, it } from 'vitest';
import { expectClauseIsolated } from 'test/utils/clauseIsolation';

/**
 * The self-check for `test/utils/clauseIsolation.ts`.
 *
 * That helper exists to answer the question a table of pins cannot: **does the row's
 * payload actually reach the clause the row is named for?** A mechanism that answers it has
 * to be shown answering it — and the only fair way to show that is to feed it the two real
 * fixtures that were green for months while the clauses they were named for were dead.
 *
 * Both are reproduced here in miniature, with no dependency on the packages they came from,
 * so this file keeps working when those move:
 *
 *  - the JWT `exp` fixture, where `JSON.stringify({ exp: NaN })` is `{"exp":null}` and the
 *    `typeof` clause — not the `Number.isFinite` clause the test is named for — is what
 *    rejects;
 *  - the SSE replay fixture, where the duplicate envelope carries a stale `sequence`, so the
 *    ordering guard drops it before the eventId dedup the test is named for ever runs.
 *
 * …and, since round 15, a THIRD fixture the helper itself could not see: a payload whose
 * clause set is accurately transcribed and whose target really does reject it, where a bound
 * in ANOTHER function produces the identical observable and the clause is dead anyway. That
 * one is not caught by asking "which of these predicates rejects?" — no list transcribed
 * beside one guard contains a bound 1400 lines away — so it is caught by the only local
 * property that distinguishes the sound fixture from the broken one: the violating payload
 * must be the MINIMAL violation. See `MASKED` below.
 *
 * It also lives in this package because `x-studio-schema` is the fastest node project in the
 * repo; nothing here is schema-specific.
 */

// ── The JWT `exp` guard, transcribed ────────────────────────────────────────────
//
//   if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) { throw … }

const EXP_CLAUSES = {
  "typeof payload.exp !== 'number'": (exp: unknown) => typeof exp !== 'number',
  '!Number.isFinite(payload.exp)': (exp: unknown) =>
    typeof exp === 'number' && !Number.isFinite(exp),
};

/** What the guard receives: the payload after the encode/decode a signed token goes through. */
function throughJsonEncoding(payload: Record<string, unknown>): unknown {
  return (JSON.parse(JSON.stringify(payload)) as { exp?: unknown }).exp;
}

// ── The SSE replay guards, transcribed ──────────────────────────────────────────
//
//   if (typeof value.sequence === 'number' && value.sequence < expectedSequence) { return; }
//   if (seenEventIds.has(value.eventId)) { return; }

interface Envelope {
  eventId: string;
  sequence?: number;
}
type ReplayState = { envelope: Envelope; expectedSequence: number; seen: string[] };

const REPLAY_CLAUSES = {
  'value.sequence < expectedSequence': ({ envelope, expectedSequence }: ReplayState) =>
    typeof envelope.sequence === 'number' && envelope.sequence < expectedSequence,
  'seenEventIds.has(value.eventId)': ({ envelope, seen }: ReplayState) =>
    seen.includes(envelope.eventId),
};

describe('expectClauseIsolated', () => {
  it('passes when the payload reaches the clause it is named for', () => {
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        // `Infinity` serialises as `null`, so the payload SHRINKS: a fixture that makes the
        // payload smaller cannot be answered by a size budget at all, which is exactly the
        // kind of thing this number is here to make visible.
        serializedWindow: -6,
        whyNotMinimal: 'finiteness is not a measurable dimension.',
        guard: 'extractSecurityClaims.ts (fixture)',
        clauses: EXP_CLAUSES,
        target: '!Number.isFinite(payload.exp)',
        control: throughJsonEncoding({ exp: 1700000000 }),
        // `1e999` is valid JSON and the ONLY way a JSON payload can carry a non-finite
        // number. `JSON.parse` yields `Infinity`.
        observed: JSON.parse('{"exp":1e999}').exp,
      }),
    ).not.toThrow();
  });

  it('fails on the `exp: NaN` fixture, naming the sibling clause that really rejects', () => {
    // The historical defect, exactly: a test named `rejects a NaN "exp" claim` whose helper
    // serialises with `JSON.stringify`. Nothing about the test's SOURCE shows the problem —
    // only the value that arrives does.
    expect(throughJsonEncoding({ exp: NaN })).toBe(null);
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        serializedWindow: 0,
        whyNotMinimal: 'finiteness is not a measurable dimension.',
        guard: 'extractSecurityClaims.ts (fixture)',
        clauses: EXP_CLAUSES,
        target: '!Number.isFinite(payload.exp)',
        control: throughJsonEncoding({ exp: 1700000000 }),
        observed: throughJsonEncoding({ exp: NaN }),
      }),
    ).toThrow(/typeof payload\.exp/);
  });

  it('fails on the stale-sequence replay fixture, naming the ordering guard', () => {
    // `deduplicates repeated event ids …` sent `evt-2` twice with `sequence: 2` both times,
    // by which point `expectedSequence` is 3 — so the ordering guard, not the dedup, is what
    // dropped the duplicate.
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        serializedWindow: 0,
        whyNotMinimal: 'set membership is not a bound.',
        guard: 'processStream.ts (fixture)',
        clauses: REPLAY_CLAUSES,
        target: 'seenEventIds.has(value.eventId)',
        control: { envelope: { eventId: 'evt-3', sequence: 3 }, expectedSequence: 3, seen: [] },
        observed: {
          envelope: { eventId: 'evt-2', sequence: 2 },
          expectedSequence: 3,
          seen: ['evt-2'],
        },
      }),
    ).toThrow(/value\.sequence < expectedSequence/);
  });

  it('passes for the same replay once the duplicate carries a fresh sequence', () => {
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        serializedWindow: 7,
        whyNotMinimal: 'set membership is not a bound.',
        guard: 'processStream.ts (fixture)',
        clauses: REPLAY_CLAUSES,
        target: 'seenEventIds.has(value.eventId)',
        control: { envelope: { eventId: 'evt-3', sequence: 3 }, expectedSequence: 3, seen: [] },
        observed: {
          envelope: { eventId: 'evt-2', sequence: 4 },
          expectedSequence: 3,
          seen: ['evt-2'],
        },
      }),
    ).not.toThrow();
  });

  it('fails when NO clause rejects — a fixture that reaches nothing at all', () => {
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        serializedWindow: 0,
        whyNotMinimal: 'finiteness is not a measurable dimension.',
        guard: 'extractSecurityClaims.ts (fixture)',
        clauses: EXP_CLAUSES,
        target: '!Number.isFinite(payload.exp)',
        control: throughJsonEncoding({ exp: 1700000000 }),
        observed: throughJsonEncoding({ exp: 1700000001 }),
      }),
    ).toThrow(/named for !Number\.isFinite/);
  });

  it('fails when the control is rejected — a clause set that rejects everything', () => {
    // Without this half, `clauses: { c: () => true }` would satisfy "the target rejects the
    // probe" for any payload whatsoever, which is the "rejects everything" pass that the
    // two-direction rule elsewhere in this suite exists to prevent.
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        serializedWindow: 0,
        whyNotMinimal: 'a synthetic always-true predicate has no dimension.',
        guard: 'fixture',
        clauses: { 'always rejects': () => true },
        target: 'always rejects',
        control: 1,
        observed: 2,
      }),
    ).toThrow(/control payload must be admitted/);
  });

  it('refuses a target that is not one of the clauses it was given', () => {
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        serializedWindow: 0,
        whyNotMinimal: 'not reached — the target check throws first.',
        guard: 'fixture',
        clauses: EXP_CLAUSES,
        target: 'a clause that does not exist',
        control: 1,
        observed: 2,
      }),
    ).toThrow(/is not one of/);
  });

  // ── The masked-clause fixture: what the first three assertions cannot see ────────
  //
  // Round-15 finding F2, in miniature. `MASKED` is a guard with a per-string cap, and a
  // SECOND bound in a different function that produces the identical outcome once the whole
  // payload is large enough. Transcribing the first guard's clauses accurately — which is
  // what an author does — leaves the second one out, because it is not one of that guard's
  // clauses and no amount of reading the guard reveals it.
  //
  // This reproduces the measured shape of `isWithinApprovalListLimits#2` +
  // `MAX_TURN_APPROVAL_SIZE`, with the two thresholds in the same 1:4 ratio.

  const ITEM_CAP = 100;
  const TOTAL_BUDGET = 400;

  /** The clause the fixture is named for, and its `||` sibling — as an author would list them. */
  const MASKED = {
    'entry.id.length > ITEM_CAP': (e: { id: string; title: string }) => e.id.length > ITEM_CAP,
    'entry.title.length > ITEM_CAP': (e: { id: string; title: string }) =>
      e.title.length > ITEM_CAP,
  };

  /** The bound nobody transcribed: a whole-payload budget, elsewhere, same observable. */
  const withheldByBudget = (e: { id: string; title: string }) =>
    e.id.length + e.title.length > TOTAL_BUDGET;

  it('passes the minimal violation, where the unlisted budget provably cannot be answering', () => {
    const control = { id: 'i'.repeat(ITEM_CAP), title: 'ok' };
    const observed = { id: 'i'.repeat(ITEM_CAP + 1), title: 'ok' };
    // Stated rather than assumed: at one character over, the second bound is nowhere near.
    expect(withheldByBudget(observed)).toBe(false);

    expect(() =>
      expectClauseIsolated({
        kind: 'bound',
        serializedWindow: 1,
        guard: 'fixture:isWithinItemLimits',
        clauses: MASKED,
        target: 'entry.id.length > ITEM_CAP',
        measure: (e) => e.id.length,
        control,
        observed,
      }),
    ).not.toThrow();
  });

  it('fails the obviously-over-cap fixture that the first three assertions accept', () => {
    const control = { id: 'i'.repeat(ITEM_CAP), title: 'ok' };
    // The payload an author reaches for when they want "definitely over the limit".
    const observed = { id: 'i'.repeat(6 * ITEM_CAP), title: 'ok' };

    // Exactly one LISTED clause rejects it, and the control is admitted — so assertions
    // (1) (2) and (3) are all satisfied. Nothing about the listed clauses is wrong.
    expect(Object.values(MASKED).filter((c) => c(observed))).toHaveLength(1);
    expect(Object.values(MASKED).some((c) => c(control))).toBe(false);
    // …and yet the unlisted budget rejects it too, with the same outcome, so deleting the
    // clause this fixture names would change nothing observable.
    expect(withheldByBudget(observed)).toBe(true);

    expect(() =>
      expectClauseIsolated({
        kind: 'bound',
        serializedWindow: 500,
        guard: 'fixture:isWithinItemLimits',
        clauses: MASKED,
        target: 'entry.id.length > ITEM_CAP',
        measure: (e) => e.id.length,
        control,
        observed,
      }),
    ).toThrow(/not the MINIMAL violation/);
  });

  it('reports the window width, so the failure says how much room a masking bound had', () => {
    expect(() =>
      expectClauseIsolated({
        kind: 'bound',
        serializedWindow: 500,
        guard: 'fixture:isWithinItemLimits',
        clauses: MASKED,
        target: 'entry.id.length > ITEM_CAP',
        measure: (e) => e.id.length,
        control: { id: 'i'.repeat(ITEM_CAP), title: 'ok' },
        observed: { id: 'i'.repeat(6 * ITEM_CAP), title: 'ok' },
      }),
    ).toThrow(/500 units wide/);
  });

  it('refuses a `bound` fixture whose measure reads the wrong field', () => {
    // The minimality check is self-checking in a way a transcribed predicate is not: a
    // `measure` that measures something other than what the clause bounds is evaluated on
    // both payloads, so it fails the `+1` assertion instead of quietly agreeing with itself.
    expect(() =>
      expectClauseIsolated({
        kind: 'bound',
        serializedWindow: 1,
        guard: 'fixture:isWithinItemLimits',
        clauses: MASKED,
        target: 'entry.id.length > ITEM_CAP',
        measure: (e) => e.title.length,
        control: { id: 'i'.repeat(ITEM_CAP), title: 'ok' },
        observed: { id: 'i'.repeat(ITEM_CAP + 1), title: 'ok' },
      }),
    ).toThrow(/not the MINIMAL violation/);
  });

  // ── The one-DIMENSION fixture: what minimality itself cannot see ─────────────────
  //
  // Round-16 finding F2, in miniature, and the reason `serializedWindow` exists. The
  // minimality check above constrains the window on the dimension `measure` NAMES. When one
  // unit of that dimension costs one character — an `id`'s length — the two windows are the
  // same number and the check does everything the docblock claimed. When one unit is a LIST
  // ENTRY, one unit is however many characters an entry happens to be, and the sibling
  // clause of the very fixture the check was written for is a list cap.
  //
  // Measured on the real guard: control 500 entities / 27 413 JSON characters, observed 501
  // with one 20 000-character entity / 47 434 characters. `kind: 'bound'`, `measure` exactly
  // the dimension the clause bounds, window one ENTRY wide, every assertion green, both
  // directions of the two-direction pin green — and byte-identical output with the clause
  // dead, because MAX_TURN_APPROVAL_SIZE = 40 000 sits inside that 20 021-character window.

  /** A guard whose first clause bounds a LIST, with the same unlisted whole-payload budget. */
  const LIST_CAP = 5;
  const LIST_CLAUSES = {
    'list.length > LIST_CAP': (v: { list: { id: string; title: string }[] }) =>
      v.list.length > LIST_CAP,
  };
  const entity = (i: number) => ({ id: `w${i}`, title: `Widget ${i}` });
  const listControl = { list: Array.from({ length: LIST_CAP }, (_unused, i) => entity(i)) };
  // Every field of this entity is exactly AT the per-string cap, so it is a legal entry — it
  // is only the LIST cap it violates. That is what makes it the dangerous payload: nothing
  // about it looks over-sized to the clause the fixture names.
  const BIG_ENTITY = { id: 'i'.repeat(ITEM_CAP), title: 'T'.repeat(ITEM_CAP) };
  const listObserved = { list: [...listControl.list, BIG_ENTITY] };

  it('records how many CHARACTERS a one-unit window is, when the unit is not a character', () => {
    // Minimal on its own dimension: exactly one entry over the cap.
    expect(listObserved.list.length).toBe(listControl.list.length + 1);

    const window = JSON.stringify(listObserved).length - JSON.stringify(listControl).length;
    // …and hundreds of characters wide on the dimension a whole-payload budget uses. The
    // conversion factor is a property of the payload's shape — one entry, here 221
    // characters — not of anything this helper can infer. A budget anywhere in the range
    // below rejects `observed`, admits `control`, and produces the identical observable with
    // the clause under test dead; that is the measured 20 021-character case in miniature.
    const LIST_BUDGET = JSON.stringify(listControl).length + 10;
    expect(JSON.stringify(listControl).length).toBeLessThanOrEqual(LIST_BUDGET);
    expect(JSON.stringify(listObserved).length).toBeGreaterThan(LIST_BUDGET);
    expect(window).toBeGreaterThan(1);

    expect(() =>
      expectClauseIsolated({
        kind: 'bound',
        serializedWindow: window,
        guard: 'fixture:isWithinListLimits',
        clauses: LIST_CLAUSES,
        target: 'list.length > LIST_CAP',
        measure: (v) => v.list.length,
        control: listControl,
        observed: listObserved,
      }),
    ).not.toThrow();
  });

  it('refuses the same fixture when the second window is claimed to be one unit too', () => {
    // The sentence the docblock used to end on — "a bound 40 000 characters away cannot hide
    // in a window one character wide" — reads as if the two windows were the same one. They
    // are the same number only when the conversion factor is 1. Writing `1` here is exactly
    // that assumption, and it is now a failing test rather than a paragraph.
    expect(() =>
      expectClauseIsolated({
        kind: 'bound',
        serializedWindow: 1,
        guard: 'fixture:isWithinListLimits',
        clauses: LIST_CLAUSES,
        target: 'list.length > LIST_CAP',
        measure: (v) => v.list.length,
        control: listControl,
        observed: listObserved,
      }),
    ).toThrow(/declares serializedWindow: 1, but `observed` is actually \d+ JSON characters/);
  });

  it('is satisfied by one character for the per-string clause, where the factor IS 1', () => {
    // The other half of the same statement, so the two ratios sit side by side: on `#2` the
    // round-15 fix works precisely because one unit of `id.length` is one JSON character.
    expect(
      JSON.stringify({ id: 'i'.repeat(ITEM_CAP + 1), title: 'ok' }).length -
        JSON.stringify({ id: 'i'.repeat(ITEM_CAP), title: 'ok' }).length,
    ).toBe(1);
  });

  it("refuses a kind: 'shape' fixture that gives no reason for skipping minimality", () => {
    // The escape hatch is a claim, not a silence — the same rule `SizeCapEntry.why` follows.
    // Without this, `kind: 'shape'` is a one-word way to opt out of the check that catches
    // a masking bound.
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        serializedWindow: 0,
        whyNotMinimal: '   ',
        guard: 'fixture:isWithinItemLimits',
        clauses: MASKED,
        target: 'entry.id.length > ITEM_CAP',
        control: { id: 'i'.repeat(ITEM_CAP), title: 'ok' },
        observed: { id: 'i'.repeat(6 * ITEM_CAP), title: 'ok' },
      }),
    ).toThrow(/no `whyNotMinimal`/);
  });

  // ── The relabelled bound: `kind: 'shape'` is no longer an opt-out of EVERYTHING ─────
  //
  // `expectClauseIsolated` throws only when `whyNotMinimal` is blank, and nothing checks that
  // the clause is not in fact a bound. So a `bound` clause declared `kind: 'shape'` with any
  // plausible sentence used to reinstate the round-15 counter-example verbatim: it skipped
  // the minimality check, which was the only assertion constraining masking. The helper's own
  // error text says "if the clause does bound a measurable dimension, use kind: 'bound'" —
  // which is an instruction to the author, not a check.
  //
  // Deciding which kind a clause really is needs a claim about the clause, and this helper
  // only has predicates. What it can do is make the declaration cost something: the SECOND
  // masking constraint is on the base type, so relabelling still has to write the payload
  // growth down and still has it checked.

  it("still checks the serialized window on a bound relabelled kind: 'shape'", () => {
    const control = { id: 'i'.repeat(ITEM_CAP), title: 'ok' };
    const observed = { id: 'i'.repeat(6 * ITEM_CAP), title: 'ok' };
    // The relabelling itself is accepted — nothing here can tell that this clause is a bound.
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        serializedWindow: 500,
        whyNotMinimal: 'an id is a name, not a measurable dimension.',
        guard: 'fixture:isWithinItemLimits',
        clauses: MASKED,
        target: 'entry.id.length > ITEM_CAP',
        control,
        observed,
      }),
    ).not.toThrow();

    // …but the 500 is not free. It is the width of the window the unlisted budget hides in —
    // `withheldByBudget` rejects `observed` and admits `control` — and it is now a checked
    // number sitting beside a stated reason that says the clause has no dimension. Declaring
    // the harmless-looking `0` a `shape` fixture would otherwise default to is refused.
    expect(withheldByBudget(observed)).toBe(true);
    expect(withheldByBudget(control)).toBe(false);
    expect(() =>
      expectClauseIsolated({
        kind: 'shape',
        serializedWindow: 0,
        whyNotMinimal: 'an id is a name, not a measurable dimension.',
        guard: 'fixture:isWithinItemLimits',
        clauses: MASKED,
        target: 'entry.id.length > ITEM_CAP',
        control,
        observed,
      }),
    ).toThrow(/declares serializedWindow: 0, but `observed` is actually 500 JSON characters/);
  });
});
