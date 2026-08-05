'use client';

import * as React from 'react';
import { useChatComposer, useChatStore } from '@mui/x-chat/headless';

/** A single queued auto-submission (see `AutoSubmitTrigger` below). */
export interface PendingAutoSubmit {
  text: string;
  seq: number;
}

/**
 * Max number of queued auto-submissions. Only two producers ever push onto this
 * queue (`pendingMessage` and `initialPrompt`), so 2 is enough headroom for both
 * to be pending at once without letting the queue grow unbounded.
 */
export const MAX_PENDING_AUTO_SUBMIT = 2;

/** Appends `item` to `queue`, keeping only the most recent `MAX_PENDING_AUTO_SUBMIT` entries. */
export function enqueuePendingAutoSubmit(
  queue: PendingAutoSubmit[],
  item: PendingAutoSubmit,
): PendingAutoSubmit[] {
  return [...queue, item].slice(-MAX_PENDING_AUTO_SUBMIT);
}

/**
 * How many times one queue entry re-attempts its deferred `submit()` before giving
 * up for this effect run. Each retry is a fresh macrotask; the only condition they
 * exist for (the send pipeline's post-stream bookkeeping, see below) clears within a
 * microtask or two, so a handful is generous. Exhausting them leaves the entry
 * QUEUED — never consumed — so a later state change still retries it.
 */
export const MAX_AUTO_SUBMIT_ATTEMPTS = 5;

// Invisible component rendered inside ChatBox (inside ChatRoot context).
// Processes `pending` as a FIFO queue: the oldest entry sets the composer value and
// submits it, one at a time.
//
// `submit()` (`useChatComposer`) is a silent no-op while a response is already
// streaming. Gating on `isSubmitting` (mapped from `store.state.isStreaming`)
// handles the common case — an auto-submit arriving while a visibly-in-flight
// response is streaming — by simply not consuming the entry yet: `isSubmitting`
// is an effect dependency, so this re-runs (and retries) the moment streaming
// ends, instead of the message silently vanishing.
//
// `isSubmitting` alone is not enough, for two reasons, and BOTH are re-checked at
// the moment of the action rather than at effect entry:
//
//  1. It is a render-time snapshot. The `submit()` below is deliberately deferred by
//     a macrotask, and a stream can start inside that gap (the user hits send, or
//     another queue entry lands), so the flag this effect closed over is stale by the
//     time it matters. `store.state.isStreaming` is therefore read LIVE inside the
//     timeout.
//  2. Even a live `isStreaming: false` doesn't guarantee `submit()` will do anything:
//     the send pipeline's internal `isSending` guard (`sendMessageActions.ts`) clears
//     in a `finally` block slightly AFTER `store.state.isStreaming` resets, and it is
//     a closure variable with no observable signal at all. A `submit()` landing in
//     that gap silently no-ops.
//
// So the entry is consumed only once the submission is OBSERVED to have happened —
// the store's message list grew (`sendExistingMessage` adds the user message
// synchronously, before its first `await`). If it didn't, the entry stays in `pending`
// and is retried on a later macrotask. Previously `onConsumed` fired unconditionally
// right after `submit()`, so an auto-submit landing in either gap was marked consumed
// and vanished: no request, no message, no error (clicking a widget's "Analysis" just
// as the previous answer finished reproduced it).
//
// Dedup lives in `pending` itself (via `onConsumed`, which removes the entry from
// the parent's `pendingAutoSubmit` state) rather than in a ref local to this
// component. In overlay mode `<Grow mountOnEnter unmountOnExit>` unmounts this
// component whenever the overlay closes, which would reset a local ref's
// consumed-set to empty — a fresh mount on reopen would then re-find and
// re-submit any entry still sitting in `pending`, causing a duplicate LLM call on
// every reopen. Pruning the entry from the state queue itself means a
// remount has nothing stale left to reprocess.
//
// `onConsumed` is called from INSIDE the deferred `setTimeout` callback, right
// after `submit()` — not synchronously up front. Pruning synchronously (before
// `submit()` fires) would change `pending`'s identity immediately, which is this
// same effect's own dependency: React would re-render and run this effect's
// cleanup — `clearTimeout(timeoutId)` — before the 0ms timeout ever gets a chance
// to fire, cancelling the very `submit()` call the entry was just marked
// "consumed" for and silently dropping the message. Deferring `onConsumed`
// alongside `submit()` means an entry is only pruned once it has actually been
// submitted; if the timeout is cancelled first (e.g. the overlay unmounts before
// it fires), the entry is left in `pending` for a future mount to retry instead
// of being lost.
export function AutoSubmitTrigger({
  pending,
  onConsumed,
  runProgrammaticComposerChange,
}: {
  pending: PendingAutoSubmit[];
  onConsumed: (seq: number) => void;
  /** See `useChatVoiceInput` — marks these composer writes as not-user-typing. */
  runProgrammaticComposerChange: (fn: () => void) => void;
}) {
  const { setValue, submit, isSubmitting } = useChatComposer();
  const store = useChatStore();

  React.useEffect(() => {
    if (isSubmitting) {
      return undefined;
    }
    const next = pending[0];
    if (!next) {
      return undefined;
    }
    let attempts = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const attempt = () => {
      // A blank entry can never satisfy `submit()`'s own "has text" guard, so waiting
      // for it to land would wedge the head of a FIFO queue forever. Drop it instead;
      // neither producer should ever enqueue one. Handled inside the deferred callback
      // like every other outcome, so a cancelled effect run (Strict Mode's double
      // invoke, an unmount) can't consume the entry twice.
      if (!next.text.trim()) {
        onConsumed(next.seq);
        return;
      }
      // (1) Live re-check. Leave the entry queued: `isSubmitting` is a dependency of
      // this effect, so the flip back to `false` when this new stream ends re-runs it.
      if (store.state.isStreaming) {
        return;
      }
      const messageCountBefore = store.state.messageIds.length;
      // Writing the composer value and clearing it on send are Studio's doing, not the
      // user's — flagged as such so an active dictation session isn't torn down by its
      // own auto-submit (see `useChatVoiceInput.handleComposerValueChange`).
      runProgrammaticComposerChange(() => {
        setValue(next.text);
        void submit();
      });
      // (2) Did it actually land?
      if (store.state.messageIds.length > messageCountBefore) {
        onConsumed(next.seq);
        return;
      }
      attempts += 1;
      if (attempts < MAX_AUTO_SUBMIT_ATTEMPTS) {
        timeoutId = setTimeout(attempt, 0);
      }
    };

    timeoutId = setTimeout(attempt, 0);
    return () => clearTimeout(timeoutId);
  }, [pending, isSubmitting, setValue, submit, onConsumed, store, runProgrammaticComposerChange]);

  return null;
}
