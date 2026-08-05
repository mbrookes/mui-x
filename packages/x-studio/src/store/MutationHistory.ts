import type { StudioDoc, StudioAIRecentMutation } from '@mui/x-studio-schema';

/**
 * The undo/redo stacks and the recent-mutation log, extracted from `StudioController`.
 *
 * WHY THIS IS ITS OWN UNIT. Five parallel arrays, a counter and a `WeakMap` have to move in
 * lockstep — the `StudioDoc[]` undo stack is 1:1 length-matched with `undoMutationLog`, the redo
 * side mirrors it, and `mutationLog` is capped INDEPENDENTLY so an entry can scroll out of it
 * while its undo pairing is still live. Nine controller members touched those seven fields, and
 * every one of them had to know the whole arrangement. Here the arrangement is one file's
 * business, and the controller sees four verbs.
 *
 * WHAT STAYS OUT. This class knows nothing about the store, the session, or how a doc becomes
 * live. {@link stepBack}/{@link stepForward} move the stacks and RETURN the doc to swap to; the
 * controller still owns `carryTransientDocState`, `normalizeSessionAfterDocSwap` and
 * `store.setState`. That split is the reason the extraction is safe: the subtle part (which doc
 * ends up on which stack, and where a redone log entry re-inserts) is pure array bookkeeping with
 * no React, no store and no I/O, and is fully exercised by the controller's existing suite.
 */

/** Undo depth. Older entries are dropped from the bottom of the stack. */
const MAX_UNDO_HISTORY = 100;

/** Recent-mutation log depth, capped INDEPENDENTLY of the undo stack. */
const MAX_MUTATION_LOG = 20;

export { MAX_UNDO_HISTORY, MAX_MUTATION_LOG };

export class MutationHistory {
  private undoStack: StudioDoc[] = [];

  private redoStack: StudioDoc[] = [];

  /** The AI-facing change log. Capped separately, so an entry may leave it while still paired. */
  private mutationLog: StudioAIRecentMutation[] = [];

  /**
   * Log entries paired 1:1 with {@link undoStack} / {@link redoStack}, `null` where the commit
   * carried no label. `undo`/`redo` locate an entry by REFERENCE, which is why the same object is
   * pushed onto both the log and the pairing stack rather than a copy.
   */
  private undoMutationLog: (StudioAIRecentMutation | null)[] = [];

  private redoMutationLog: (StudioAIRecentMutation | null)[] = [];

  /**
   * Exact insertion order per log entry.
   *
   * NOT the public `at` ISO timestamp: that has millisecond resolution, so two commits in one
   * synchronous chain (routine in tests, reachable with two AI-tool mutations in a turn) can share
   * a value, and a strict `>` comparison on it silently falls back to appending at the tail. A
   * private side-table gives every entry a collision-free order without changing the public shape.
   */
  private seqCounter = 0;

  private readonly seq = new WeakMap<StudioAIRecentMutation, number>();

  /** Wipe every stack. Used when a commit replaces the document wholesale (a load). */
  reset(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.mutationLog = [];
    this.undoMutationLog = [];
    this.redoMutationLog = [];
  }

  /**
   * Record a doc-changing commit.
   *
   * `undoable` and `label` are INDEPENDENT, deliberately. An undo entry is pushed only when the
   * commit is undoable; the log line is recorded whenever a label was supplied, undoable or not —
   * a non-undoable but genuine document change (the AI wire path's `setActivePage` /
   * `renameAIThread`) is still a change the model's log must surface. A non-undoable labeled
   * commit therefore has no paired entry, which is correct: undo can never reach it.
   */
  record(previousDoc: StudioDoc, label: string | null, undoable: boolean): void {
    // Built once so the SAME reference lands in both the log and the pairing stack.
    const logEntry: StudioAIRecentMutation | null = label
      ? { label, at: new Date().toISOString() }
      : null;
    if (logEntry) {
      this.seq.set(logEntry, this.seqCounter);
      this.seqCounter += 1;
    }

    if (undoable) {
      this.undoStack.push(previousDoc);
      this.undoMutationLog.push(logEntry);
      // Any new undoable action invalidates the redo branch.
      this.redoStack = [];
      this.redoMutationLog = [];
      if (this.undoStack.length > MAX_UNDO_HISTORY) {
        this.undoStack.shift();
        this.undoMutationLog.shift();
      }
    }

    if (logEntry) {
      this.mutationLog.push(logEntry);
      if (this.mutationLog.length > MAX_MUTATION_LOG) {
        this.mutationLog.shift();
      }
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Pop one undo step: push `currentDoc` onto the redo stack and return the doc to swap TO, or
   * `null` when there is nothing to undo. The paired log entry moves to the redo pairing stack and
   * is removed from the visible log by reference — it may already have scrolled out, hence the
   * `indexOf` guard.
   */
  stepBack(currentDoc: StudioDoc): StudioDoc | null {
    const previousDoc = this.undoStack.pop();
    const paired = this.undoMutationLog.pop() ?? null;
    if (previousDoc == null) {
      return null;
    }
    this.redoMutationLog.push(paired);
    if (paired) {
      const idx = this.mutationLog.indexOf(paired);
      if (idx !== -1) {
        this.mutationLog.splice(idx, 1);
      }
    }
    this.redoStack.push(currentDoc);
    return previousDoc;
  }

  /**
   * The mirror of {@link stepBack}, with one asymmetry that matters: a redone entry is re-inserted
   * at its ORIGINAL position, not appended.
   *
   * A non-undoable but labeled commit can land between an entry's undo and its redo without
   * clearing the redo stack, so a genuinely newer entry may already sit in the log. Appending
   * would report the two in the wrong order. The insertion point is found with the private
   * sequence counter rather than the public `at` timestamp, for the resolution reason on
   * {@link seq}.
   */
  stepForward(currentDoc: StudioDoc): StudioDoc | null {
    const nextDoc = this.redoStack.pop();
    const paired = this.redoMutationLog.pop() ?? null;
    if (nextDoc == null) {
      return null;
    }
    this.undoMutationLog.push(paired);
    if (paired) {
      const pairedSeq = this.seq.get(paired) ?? -1;
      const insertAt = this.mutationLog.findIndex(
        (entry) => (this.seq.get(entry) ?? -1) > pairedSeq,
      );
      if (insertAt === -1) {
        this.mutationLog.push(paired);
      } else {
        this.mutationLog.splice(insertAt, 0, paired);
      }
      if (this.mutationLog.length > MAX_MUTATION_LOG) {
        this.mutationLog.shift();
      }
    }
    this.undoStack.push(currentDoc);
    return nextDoc;
  }

  /**
   * Collapse every undo entry pushed since `baselineDoc` into that one step, so a multi-commit
   * gesture (a grid header-sort cycle) costs one Ctrl+Z rather than three.
   *
   * TRUNCATES the stack past the baseline, so a STALE baseline would destroy an edit made in
   * between — callers must prove the current doc is still the exact reference their own previous
   * commit produced. The surviving step inherits the LAST non-null folded label, so the gesture
   * reports its final state rather than its first.
   */
  foldSince(baselineDoc: StudioDoc): void {
    const baseIndex = this.undoStack.lastIndexOf(baselineDoc);
    if (baseIndex === -1 || baseIndex === this.undoStack.length - 1) {
      return;
    }
    const folded = this.undoMutationLog.slice(baseIndex + 1);
    this.undoStack.length = baseIndex + 1;
    this.undoMutationLog.length = baseIndex + 1;
    const lastLogEntry = folded.filter((entry) => entry !== null).pop() ?? null;
    if (lastLogEntry) {
      this.undoMutationLog[baseIndex] = lastLogEntry;
    }
  }

  /** A copy, so a caller cannot mutate the log through the returned array. */
  recent(): StudioAIRecentMutation[] {
    return [...this.mutationLog];
  }

  /** The doc stacks, for session serialization. */
  snapshot(): { undo: StudioDoc[]; redo: StudioDoc[] } {
    // Copies, for the same reason: a serializer holding the live stacks would observe them
    // changing under it. Both are bounded by `MAX_UNDO_HISTORY`, so the copy is cheap.
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  /**
   * Reinstate serialized doc stacks.
   *
   * The pairing stacks are refilled with `null`s to the SAME lengths rather than restored: a
   * serialized session carries docs, not log entries, and the 1:1 length match is the invariant
   * `stepBack`/`stepForward` rely on. Restoring docs without it would desynchronize every
   * subsequent pop.
   */
  restore(undo: StudioDoc[], redo: StudioDoc[]): void {
    // COPIED, not aliased. `stepBack`/`stepForward` `pop()` these arrays, so holding the caller's
    // reference would mutate a caller's array out from under it. The previous inline
    // implementation was accidentally safe — its `.slice(-MAX_UNDO_HISTORY)` always produced a
    // fresh array — which is exactly the kind of incidental guarantee an extraction has to make
    // explicit rather than inherit.
    this.undoStack = [...undo];
    this.redoStack = [...redo];
    this.undoMutationLog = undo.map(() => null);
    this.redoMutationLog = redo.map(() => null);
    this.mutationLog = [];
  }
}
