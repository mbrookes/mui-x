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
        guard: 'fixture',
        clauses: EXP_CLAUSES,
        target: 'a clause that does not exist',
        control: 1,
        observed: 2,
      }),
    ).toThrow(/is not one of/);
  });
});
