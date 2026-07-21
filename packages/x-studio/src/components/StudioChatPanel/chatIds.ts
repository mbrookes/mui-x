/**
 * Collision-resistant id generators for chat threads and messages.
 *
 * A plain `` `thread-${Date.now()}` `` (or `msg-${Date.now()}`) collides whenever
 * two threads/messages are created within the same millisecond — easy to hit
 * with rapid "New chat" clicks or fast-arriving stream chunks. Each generator
 * below pairs the timestamp with a module-level monotonically increasing
 * counter so two ids created in the same millisecond are still unique.
 */

let threadIdCounter = 0;
let messageIdCounter = 0;
let autoSubmitSeqCounter = 0;

/** Generates a unique id for a new AI chat thread. */
export function createThreadId(): string {
  threadIdCounter += 1;
  return `thread-${Date.now()}-${threadIdCounter}`;
}

/** Generates a unique id for a new AI chat message. */
export function createMessageId(): string {
  messageIdCounter += 1;
  return `msg-${Date.now()}-${messageIdCounter}`;
}

/**
 * Generates a unique, monotonically increasing sequence number for the chat panel's
 * auto-submit queue (`StudioChatPanel`'s `pendingMessage.id` / `initialPrompt` `seq`,
 * and `StudioContent`'s `pendingInsight.id`, which flows into `pendingMessage`).
 *
 * A plain `Date.now()` has millisecond resolution, so two auto-submit-eligible events
 * (e.g. an `initialPrompt` mount-submit and a widget-insight click) landing in the same
 * millisecond would share a value — the auto-submit queue's dedup treats that as the
 * SAME entry and silently drops the second one. A module-level counter guarantees every
 * call returns a distinct, ordered value regardless of timing.
 */
export function nextAutoSubmitSeq(): number {
  autoSubmitSeqCounter += 1;
  return autoSubmitSeqCounter;
}
