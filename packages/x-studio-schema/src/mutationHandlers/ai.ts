/** AI conversation-thread mutations. */
import type { StudioDoc } from '../stateTypes';
import { resolveTargetId } from './shared';
import type { HandlersFor } from './shared';

/**
 * The `ai.threads` counterpart of {@link resolveTargetPageId}, with the identical
 * three-state shape: nullish ⇒ the applying side's active thread (the legacy
 * threadId-less fallback), a `string` ⇒ that thread, anything else ⇒ `undefined` so the
 * caller no-ops.
 *
 * `renameAIThread` was the ONE handler of the fourteen missing the string-id rule: its
 * `args.threadId ?? state.ai.activeThreadId` accepts ANY non-nullish value, so a
 * `threadId: 42` neither fell back to the active thread nor matched any thread's string
 * `id` — a silent no-op that looked like a successful rename to the producer. Routing it
 * through this resolver makes the non-string case an explicit, documented no-op instead.
 */
export function resolveTargetThreadId(ai: StudioDoc['ai'], threadId: unknown): string | undefined {
  return resolveTargetId(threadId, ai?.activeThreadId);
}

export const AI_MUTATION_HANDLERS: HandlersFor<'renameAIThread'> = {
  renameAIThread: {
    apply: (state, args) => {
      if (!state.ai) {
        return state;
      }
      // Require STRING `name`/`updatedAt`: the thread's `name`/`updatedAt` are typed
      // `string`, and the chat panel's thread selector renders `name` directly as text with
      // no fallback of its own.
      if (typeof args.name !== 'string' || typeof args.updatedAt !== 'string') {
        return state;
      }
      // Explicit, server-stamped target thread — falls back to the applying side's
      // active thread only for legacy payloads. Targeting an explicit id keeps the
      // rename on the thread the request belongs to even if the user switched
      // threads while the model was running.
      //
      // Resolved through the shared helper so a NON-STRING explicit `threadId` no-ops
      // rather than being compared against every thread's string `id` (string-id rule),
      // exactly as `resolveTargetPageId` does for the three page-targeting handlers.
      const targetThreadId = resolveTargetThreadId(state.ai, args.threadId);
      if (!targetThreadId) {
        return state;
      }
      // `updatedAt` is stamped once by the producer (server-side) and carried in
      // the mutation, so the server-computed and client-applied results agree.
      // The reducer must never call `new Date()` itself (would be non-deterministic).
      // Reference-equality no-op: a `targetThreadId` matching no thread (the unknown-id
      // case the contract names), or a matched thread whose name+timestamp are already
      // identical, returns the SAME doc so `commitDocPatch`'s no-op guard skips a
      // spurious undo entry.
      let changed = false;
      const updatedThreads = (state.ai.threads ?? []).map((t) => {
        if (t.id !== targetThreadId || (t.name === args.name && t.updatedAt === args.updatedAt)) {
          return t;
        }
        changed = true;
        return { ...t, name: args.name, updatedAt: args.updatedAt };
      });
      if (!changed) {
        return state;
      }
      return {
        ...state,
        ai: { ...state.ai, threads: updatedThreads },
      };
    },
    label: () => 'renameAIThread',
  },
};
