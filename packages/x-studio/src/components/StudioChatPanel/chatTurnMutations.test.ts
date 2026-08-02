import { describe, expect, it } from 'vitest';
import type { StudioController } from '../../store/StudioController';
import type { StudioDoc } from '../../models';
import { createChatTurnMutationLedger, MAX_TRACKED_TURNS } from './chatTurnMutations';

/**
 * The turn ledger's retention cap.
 *
 * Round-15 finding F1. `chatTurnMutations.ts` had no test file at all, and
 * `MAX_TRACKED_TURNS` occurs exactly twice in the package — its declaration and its one
 * use — so nothing anywhere exercised the pruning loop. It was also invisible to the size-cap
 * scan that is supposed to make exactly that situation impossible: the scan matched a size
 * compared against a SCREAMING_SNAKE NAME on the RIGHT of a `.length`, and this cap is
 * written on a `Map`'s `.size`. So the inventory reported every cap at these boundaries
 * accounted for while a real, untested one sat inside a directory it walks.
 *
 * What the cap is load-bearing for is not a wire boundary but memory: each entry pins TWO
 * whole `StudioDoc` snapshots, and the ledger lives for the lifetime of the chat panel. With
 * the bound gone a long session retains every document it ever produced.
 */
describe('createChatTurnMutationLedger — retention', () => {
  /**
   * The ledger only reaches the controller on `revert`; `record` and `has` never touch it,
   * so the retention cap can be exercised without a real store.
   */
  function makeLedger() {
    const controller = {
      getState: () => ({ doc: {} as StudioDoc }),
    } as unknown as StudioController;
    return createChatTurnMutationLedger(controller);
  }

  /** Distinct doc snapshots, since the ledger stores them by reference. */
  const docFor = (turn: number) => ({ marker: turn }) as unknown as StudioDoc;

  it('keeps the most recent MAX_TRACKED_TURNS turns and evicts older ones', () => {
    const ledger = makeLedger();
    // One more turn than the cap allows: the very first must be gone, the rest must remain.
    for (let turn = 0; turn <= MAX_TRACKED_TURNS; turn += 1) {
      ledger.record(`assistant-${turn}`, docFor(turn), docFor(turn + 1000));
    }

    expect(ledger.has('assistant-0')).toBe(false);
    const retained = Array.from({ length: MAX_TRACKED_TURNS }, (_unused, i) =>
      ledger.has(`assistant-${i + 1}`),
    );
    expect(retained).toEqual(Array.from({ length: MAX_TRACKED_TURNS }, () => true));
  });

  it('evicts in insertion order, oldest first, however far past the cap it goes', () => {
    const ledger = makeLedger();
    const total = MAX_TRACKED_TURNS * 3;
    for (let turn = 0; turn < total; turn += 1) {
      ledger.record(`assistant-${turn}`, docFor(turn), docFor(turn + 1000));
    }

    const held = Array.from({ length: total }, (_unused, i) => i).filter((i) =>
      ledger.has(`assistant-${i}`),
    );
    // Exactly the last MAX_TRACKED_TURNS, and nothing else — a cap that pruned the WRONG
    // end would keep the same COUNT while making Retry revert somebody else's turn.
    expect(held).toEqual(
      Array.from({ length: MAX_TRACKED_TURNS }, (_unused, i) => total - MAX_TRACKED_TURNS + i),
    );
  });

  it('refreshes an existing turn in place rather than spending a new slot', () => {
    const ledger = makeLedger();
    // `record` is called once per applied mutation, so a single agentic turn applying many
    // mutations must not evict the eight turns before it.
    ledger.record('assistant-0', docFor(0), docFor(1));
    for (let call = 0; call < MAX_TRACKED_TURNS * 4; call += 1) {
      ledger.record('assistant-0', docFor(0), docFor(call + 2));
    }
    expect(ledger.has('assistant-0')).toBe(true);
  });

  // Read off the constant above, so a token-preserving mutation of the USE site reddens the
  // two tests above. This pins the DECLARATION too, so raising the constant cannot quietly
  // relax the cap and its expectations together.
  it('keeps MAX_TRACKED_TURNS small enough that two doc snapshots each stay bounded', () => {
    expect(MAX_TRACKED_TURNS).toBe(8);
  });
});
