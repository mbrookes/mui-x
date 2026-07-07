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
