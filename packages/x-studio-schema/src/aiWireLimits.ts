/**
 * Budgets on the AI-chat wire, shared by the two sides that must agree on them.
 *
 * Distinct from `wireLimits.ts`, which answers "is this single array/string too large to be a
 * legitimate payload". These answer "how much tool output may cross this wire", and they have
 * TWO implementers: `@mui/x-studio-ai-middleware` enforces them when it builds the conversation,
 * and `@mui/x-studio`'s SSE adapter mirrors them when it decides how much of a streamed result
 * to store. A client budget below the server's clips results the server explicitly allowed —
 * and the clipped text is what gets replayed to the model on the next request, so the model is
 * told a partial answer is the whole one.
 *
 * That is not hypothetical: the client's turn budget was set to 600,000 by an argument about
 * "three at-server-cap results" while the server's own ceiling was 2,000,000, and nothing
 * connected the two numbers except a comment. Defining them here is what makes the client's
 * mirror a derivation rather than a claim.
 *
 * A host is free to run its own AI endpoint with different budgets — these are the REFERENCE
 * server's, and the client's mirror is a storage bound, not a protocol requirement. But when
 * the two do disagree, they should disagree deliberately.
 *
 * Zero-dependency by design (mirrors `unsafeKeys.ts`/`wireLimits.ts`) so either side can import
 * from here without pulling in the rest of the package.
 */

/**
 * Cap (chars, ~bytes of JSON text) on a SINGLE tool result.
 *
 * Sized so a legitimate 1000-row query result with ordinary cell values passes untouched
 * (~200 KB is roughly 50K tokens — already a large single tool result), while a runaway result
 * is bounded well before it can dominate the conversation. `capToolOutput` enforces it by
 * structurally trimming an oversized result; the client mirrors it as `MAX_TOOL_OUTPUT_SIZE`.
 */
export const MAX_TOOL_OUTPUT_CHARS = 200_000;

/**
 * Cap on the TOTAL serialized size of one in-flight conversation — the `messages` array the
 * agentic loop re-POSTs, in full, on every remaining turn.
 *
 * Roughly 500K tokens at ~4 chars/token, already beyond most models' context windows, so a
 * conversation this large has failed regardless. It is twice `MAX_SYSTEM_PROMPT_CHARS` because
 * the conversation legitimately carries the whole system prompt plus history.
 *
 * This is also the ceiling on how much tool output can reach the client in one response, which
 * is why the client sizes its per-response storage budget against it: a turn the server was
 * willing to send is a turn the client should be willing to store whole.
 */
export const MAX_CONVERSATION_CHARS = 2_000_000;
