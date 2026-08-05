import { describe, it, expect } from 'vitest';
import type { StudioDoc } from '@mui/x-studio-schema';
import { MutationHistory, MAX_UNDO_HISTORY, MAX_MUTATION_LOG } from './MutationHistory';

/**
 * The stack bookkeeping, tested directly.
 *
 * `StudioController.test.ts` already covers undo/redo end to end and is the regression net for
 * this extraction. What it CANNOT reach cheaply is the arithmetic at the edges — the independent
 * caps, the 1:1 pairing after a restore, the sequence-ordered re-insertion — because driving each
 * one through the controller means constructing that many real commits. Those are this file's job.
 *
 * A doc is an opaque reference here on purpose: the history never inspects one, and a test that
 * built real `StudioDoc`s would be asserting the factory's behaviour, not the stack's.
 */
const doc = (id: string) => ({ id }) as unknown as StudioDoc;

describe('MutationHistory — undo/redo stacks', () => {
  it('reports nothing to undo or redo when empty', () => {
    const h = new MutationHistory();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.stepBack(doc('a'))).toBe(null);
    expect(h.stepForward(doc('a'))).toBe(null);
  });

  it('round-trips a doc through undo and redo', () => {
    const h = new MutationHistory();
    const a = doc('a');
    const b = doc('b');
    h.record(a, 'edit', true);
    expect(h.canUndo()).toBe(true);

    expect(h.stepBack(b)).toBe(a);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);

    expect(h.stepForward(a)).toBe(b);
    expect(h.canRedo()).toBe(false);
    expect(h.canUndo()).toBe(true);
  });

  it('a non-undoable commit is logged but creates no undo step', () => {
    const h = new MutationHistory();
    h.record(doc('a'), 'ai-edit', false);
    expect(h.canUndo()).toBe(false);
    // The log line is still recorded: a non-undoable but genuine document change is one the
    // model's change log must surface.
    expect(h.recent().map((entry) => entry.label)).toEqual(['ai-edit']);
  });

  it('an unlabeled commit creates an undo step but no log line', () => {
    const h = new MutationHistory();
    h.record(doc('a'), null, true);
    expect(h.canUndo()).toBe(true);
    expect(h.recent()).toEqual([]);
  });

  it('a new undoable commit invalidates the redo branch', () => {
    const h = new MutationHistory();
    h.record(doc('a'), 'first', true);
    h.stepBack(doc('b'));
    expect(h.canRedo()).toBe(true);

    h.record(doc('c'), 'second', true);
    expect(h.canRedo()).toBe(false);
  });
});

describe('MutationHistory — the two caps are independent', () => {
  it('evicts the oldest undo entry past MAX_UNDO_HISTORY, keeping the newest', () => {
    const h = new MutationHistory();
    const docs = Array.from({ length: MAX_UNDO_HISTORY + 5 }, (_, i) => doc(`d${i}`));
    docs.forEach((d) => h.record(d, null, true));
    // The stack holds the last MAX_UNDO_HISTORY, so stepping back reaches the newest first and
    // the five oldest are gone entirely.
    let steps = 0;
    while (h.canUndo()) {
      h.stepBack(doc('cur'));
      steps += 1;
    }
    expect(steps).toBe(MAX_UNDO_HISTORY);
  });

  it('caps the log separately, so an entry can leave it while its undo pairing is live', () => {
    const h = new MutationHistory();
    const total = MAX_MUTATION_LOG + 3;
    Array.from({ length: total }, (_, i) => i).forEach((i) =>
      h.record(doc(`d${i}`), `m${i}`, true),
    );

    expect(h.recent()).toHaveLength(MAX_MUTATION_LOG);
    expect(h.recent()[0].label).toBe(`m${total - MAX_MUTATION_LOG}`);
    // …but every one of them is still undoable: the caps do not track each other.
    expect(h.canUndo()).toBe(true);
  });

  it('undoing an entry that already scrolled out of the log is not an error', () => {
    const h = new MutationHistory();
    const total = MAX_MUTATION_LOG + 2;
    Array.from({ length: total }, (_, i) => i).forEach((i) =>
      h.record(doc(`d${i}`), `m${i}`, true),
    );
    // Unwind past the point where the paired entries are no longer in the visible log. The
    // `indexOf` guard is what makes this a no-op rather than a splice at -1.
    for (let i = 0; i < total; i += 1) {
      expect(h.stepBack(doc(`cur${i}`))).not.toBe(null);
    }
    expect(h.recent()).toEqual([]);
  });
});

describe('MutationHistory — redo re-inserts by sequence, not at the tail', () => {
  it('restores a redone entry to its original position', () => {
    const h = new MutationHistory();
    h.record(doc('a'), 'first', true);
    h.record(doc('b'), 'second', true);
    expect(h.recent().map((entry) => entry.label)).toEqual(['first', 'second']);

    // Undo 'second' — it leaves the log.
    h.stepBack(doc('c'));
    expect(h.recent().map((entry) => entry.label)).toEqual(['first']);

    // A non-undoable labeled commit lands in between WITHOUT clearing the redo stack, so a
    // genuinely newer entry now sits in the log ahead of the one about to be redone.
    h.record(doc('d'), 'interleaved', false);
    expect(h.recent().map((entry) => entry.label)).toEqual(['first', 'interleaved']);

    // Redoing must put 'second' back BEFORE 'interleaved' — appending would report the two in
    // the wrong order. This is what the private sequence counter exists for; the public `at`
    // timestamp has millisecond resolution and ties here.
    h.stepForward(doc('e'));
    expect(h.recent().map((entry) => entry.label)).toEqual(['first', 'second', 'interleaved']);
  });
});

describe('MutationHistory — foldSince', () => {
  it('collapses every step since the baseline into one', () => {
    const h = new MutationHistory();
    const base = doc('base');
    h.record(base, 'sort:asc', true);
    h.record(doc('s1'), 'sort:desc', true);
    h.record(doc('s2'), 'sort:none', true);

    h.foldSince(base);

    // One step back reaches the baseline: the whole gesture costs a single Ctrl+Z.
    expect(h.stepBack(doc('cur'))).toBe(base);
    expect(h.canUndo()).toBe(false);
  });

  it('adopts the LAST folded label, so the step reports the gesture end state', () => {
    const h = new MutationHistory();
    const base = doc('base');
    h.record(base, 'sort:asc', true);
    h.record(doc('s1'), 'sort:none', true);
    h.foldSince(base);
    h.stepBack(doc('cur'));
    // The surviving pairing carries 'sort:none', so undoing removes THAT from the log.
    expect(h.recent().map((entry) => entry.label)).toEqual(['sort:asc']);
  });

  it('is a no-op for an unknown baseline, rather than truncating the stack', () => {
    const h = new MutationHistory();
    h.record(doc('a'), 'edit', true);
    h.foldSince(doc('never-committed'));
    expect(h.canUndo()).toBe(true);
  });
});

describe('MutationHistory — reset and restore', () => {
  it('reset clears every stack', () => {
    const h = new MutationHistory();
    h.record(doc('a'), 'edit', true);
    h.stepBack(doc('b'));
    h.reset();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.recent()).toEqual([]);
  });

  it('restore re-establishes the 1:1 pairing, so subsequent pops stay aligned', () => {
    const h = new MutationHistory();
    const past = [doc('p1'), doc('p2')];
    const future = [doc('f1')];
    h.restore(past, future);

    // A serialized session carries docs and never log entries, so the log starts empty and every
    // pairing is null — but the LENGTHS must match, or every later pop desynchronizes.
    expect(h.recent()).toEqual([]);
    expect(h.stepBack(doc('cur'))).toBe(past[1]);
    expect(h.stepBack(doc('cur2'))).toBe(past[0]);
    expect(h.canUndo()).toBe(false);
    // Three redo entries now: the restored `f1` plus the two docs that were CURRENT at each
    // undo. Stepping forward returns the most recent of those — `cur2`, the doc live when the
    // last undo happened — NOT a doc off the restored past. That asymmetry is the whole point of
    // the pairing: undo pushes where it came FROM, redo returns where it was going TO.
    expect(h.stepForward(doc('c1'))).toEqual({ id: 'cur2' });
  });

  it('snapshot exposes the stacks for session serialization', () => {
    const h = new MutationHistory();
    const a = doc('a');
    h.record(a, 'edit', true);
    expect(h.snapshot().undo).toEqual([a]);
    expect(h.snapshot().redo).toEqual([]);
  });
});
