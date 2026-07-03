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
 */
import type { StudioController } from '../../store/StudioController';
import type { StateMutation } from '../../models';

/**
 * Applies a single `StateMutation` to the local `StudioController`.
 *
 * Called by the thin client adapter whenever a `state-mutation` SSE event arrives.
 */
export function applyStateMutation(mutation: StateMutation, controller: StudioController): void {
  controller.applyExternalMutation(mutation);
}
