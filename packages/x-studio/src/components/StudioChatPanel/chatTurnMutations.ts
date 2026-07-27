'use client';

import * as React from 'react';
import type { StudioDoc } from '../../models';
import type { StudioController } from '../../store/StudioController';

/**
 * Per-assistant-turn record of the `state-mutation` events that actually changed
 * the document, used to make **Retry** non-duplicating.
 *
 * The problem it solves: an agentic turn ("add a revenue chart and a KPI") applies
 * its mutations incrementally as they stream in. If the connection drops after the
 * chart landed, the user's only recovery is Retry — which replays the WHOLE turn
 * server-side with freshly minted ids, so the chart is added a second time. The
 * mutations are already committed to `doc`; nothing downstream can tell the replay
 * "you already did half of this".
 *
 * Why revert-before-replay (rather than idempotent replay): making the replay
 * idempotent needs a stable per-mutation envelope id threaded from the server
 * through the SSE protocol into the reducer — a protocol change across three
 * packages, and it still can't dedup a mutation the model re-derives with a
 * different payload. Reverting is entirely client-side, needs no protocol change,
 * and matches what the user asked for: "throw that answer away and try again"
 * should also throw away that answer's edits.
 *
 * Safety: the revert only fires when the document is still **reference-identical**
 * to what the turn left behind. Every controller commit produces a new `doc`
 * object, so any user edit, undo, or later AI turn in between makes the check fail
 * and the revert is skipped (a stale snapshot would silently discard that
 * intervening work — far worse than a duplicate widget). The revert itself is a
 * normal undoable commit, so the user can undo it like any other edit.
 */
export interface StudioChatTurnMutationLedger {
  /**
   * Records that the assistant turn producing `messageId` moved the document from
   * `docBefore` to `docAfter`. Called once per applied mutation; the first call for
   * a turn pins `docBefore`, every call refreshes `docAfter`.
   */
  record: (messageId: string, docBefore: StudioDoc, docAfter: StudioDoc) => void;
  /**
   * Reverts the recorded mutations of `messageId`'s turn, if and only if the
   * document is still exactly where that turn left it. Returns `true` when a
   * revert was committed. Always forgets the turn afterwards, so a second call
   * (or a second retry) can never revert twice.
   */
  revert: (messageId: string) => boolean;
  /** Test/introspection helper: whether a turn currently has revertible mutations. */
  has: (messageId: string) => boolean;
}

interface TurnRecord {
  docBefore: StudioDoc;
  docAfter: StudioDoc;
}

/**
 * Max number of turns kept. Only the most recent answers realistically get retried,
 * and each entry pins two whole `doc` snapshots, so the map is bounded rather than
 * growing for the lifetime of the panel.
 */
const MAX_TRACKED_TURNS = 8;

export function createChatTurnMutationLedger(
  controller: StudioController,
): StudioChatTurnMutationLedger {
  // Insertion-ordered, so pruning the oldest entry is `keys().next()`.
  const turns = new Map<string, TurnRecord>();

  return {
    record(messageId, docBefore, docAfter) {
      const existing = turns.get(messageId);
      if (existing) {
        existing.docAfter = docAfter;
        return;
      }
      turns.set(messageId, { docBefore, docAfter });
      while (turns.size > MAX_TRACKED_TURNS) {
        const oldest = turns.keys().next();
        if (oldest.done) {
          break;
        }
        turns.delete(oldest.value);
      }
    },
    revert(messageId) {
      const turn = turns.get(messageId);
      if (!turn) {
        return false;
      }
      turns.delete(messageId);
      const state = controller.getState();
      if (state.doc !== turn.docAfter) {
        // Something committed after this turn (a user edit, an undo, another AI
        // turn). Restoring `docBefore` would silently discard it, so leave the
        // document alone and accept the duplicate risk for this one replay.
        return false;
      }
      controller.setState({ ...state, doc: turn.docBefore }, { undoable: true });
      return true;
    },
    has(messageId) {
      return turns.has(messageId);
    },
  };
}

/**
 * Exposes the panel's ledger to `StudioMessageActions`, which is rendered by
 * `ChatBox` as a slot (so it can't be passed props directly) and lives outside the
 * Studio controller's own context in standalone usage. `null` = no ledger wired up,
 * in which case Retry simply doesn't revert.
 */
export const StudioChatTurnMutationContext =
  React.createContext<StudioChatTurnMutationLedger | null>(null);

export function useStudioChatTurnMutations(): StudioChatTurnMutationLedger | null {
  return React.useContext(StudioChatTurnMutationContext);
}
