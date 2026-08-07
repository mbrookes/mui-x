/**
 * Applies a `StateMutation` (received from the x-studio-ai-middleware SSE stream)
 * to the local `StudioController`.
 *
 * Historically this file re-derived each mutation's effect by mapping it to
 * individual `StudioController` methods — a second, independently-authored
 * implementation of logic the server had already run to compute its threaded
 * `nextState`. Those two implementations had already drifted (page-targeting).
 *
 * Now there is exactly one implementation of every mutation's effect: the shared
 * `applyMutation` reducer in `@mui/x-studio-schema`. The controller applies it
 * through `applyExternalMutation`, so the client-applied state is guaranteed to
 * match the server-threaded state.
 *
 * This is also the ONE trust boundary where a value claiming to be a
 * `StateMutation` arrives from outside the process that produced it (the SSE
 * payload was `JSON.parse`'d), so the value is validated through
 * `parseStateMutation` before it reaches the controller — a malformed event is
 * dropped (logged, not applied) rather than corrupting state.
 */
import { parseStateMutation } from '@mui/x-studio-schema';
import type { StudioController } from '@mui/x-studio-core/store';

/**
 * Validates and applies a single wire-sourced `state-mutation` event to the local
 * `StudioController`.
 *
 * Called by the thin client adapter whenever a `state-mutation` SSE event arrives.
 * The `value` is untrusted (deserialized network input): it is run through
 * `parseStateMutation` first, and a value that fails validation is logged and
 * dropped WITHOUT touching the controller (never thrown — one bad event must not
 * kill the SSE stream). Only a validated mutation reaches
 * `controller.applyExternalMutation`.
 */
export function applyStateMutation(value: unknown, controller: StudioController): void {
  const parsed = parseStateMutation(value);
  if (!parsed.ok) {
    console.error(`[StudioBackendAdapter] Dropped malformed state-mutation event: ${parsed.error}`);
    return;
  }
  controller.applyExternalMutation(parsed.mutation);
}
