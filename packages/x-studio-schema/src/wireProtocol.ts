/**
 * Versioning for the two wires between a Studio client and its host's servers.
 *
 * Studio's whole integration story is "run these two handlers in your backend":
 * `handleAIChat` from `@mui/x-studio-ai-middleware` and `handleBatchQuery` from
 * `@mui/x-studio-data-middleware`. A host therefore upgrades `@mui/x-studio` and its server
 * SEPARATELY — that is the normal case for this shape of library, not an edge case.
 *
 * Shared TYPES do not make that safe. Both sides compile against `@mui/x-studio-schema`, but they
 * compile against WHICHEVER COPY each side installed, and nothing at runtime compares the two. So
 * a client one version ahead of its server discovered the mismatch as a field-level validation
 * failure deep inside request handling — "expected an object with a widgets array", or a tool call
 * rejected for an argument the server had never heard of — which reads as a bug in the payload
 * rather than as what it is: two versions talking past each other.
 *
 * A version on the envelope turns that into a refused handshake with an actionable message, at the
 * first thing either handler looks at.
 *
 * ## Two counters, not one
 *
 * The AI wire and the data wire change independently, and they are consumed by different servers
 * that a host may well upgrade at different times. One shared counter would force a bump on the
 * AI wire for a change to the SQL protocol, and a version number that changes for reasons
 * unrelated to you is a version number people learn to ignore.
 *
 * ## The compatibility rule
 *
 * Each wire declares a CURRENT version (what this build sends) and a MIN_SUPPORTED version (the
 * oldest a server built from this source will accept). A server accepts
 * `MIN_SUPPORTED <= received <= CURRENT` and refuses anything else:
 *
 * - **Below MIN_SUPPORTED** — the client is too old. The server cannot read the payload's older
 *   shape, so the only honest answer is to say so and name the version it needs.
 * - **Above CURRENT** — the client is NEWER than the server. This is the case a permissive rule
 *   gets wrong: the request may carry a field this server drops silently, so the dashboard renders
 *   numbers computed without it. Refusing is the conservative answer and the one that surfaces the
 *   real problem, which is a half-finished deployment.
 * - **Absent** — a pre-versioning client, reported as version 0 so the message can say exactly
 *   that rather than "expected a number".
 *
 * The range exists so an additive-only change can widen compatibility deliberately (bump CURRENT,
 * leave MIN_SUPPORTED) rather than by default. Today both wires sit at 1: the versions were
 * introduced together, and there is no older shape any released build could be sending.
 *
 * ## When to bump
 *
 * Bump CURRENT when a field is added, removed or re-interpreted on a request or response envelope,
 * or anything reachable from one. Bump MIN_SUPPORTED to the same number when the change is NOT
 * additive — when a server built from this source can no longer correctly serve the previous
 * shape. Leaving MIN_SUPPORTED behind is a promise that the older payload still produces the right
 * answer, so make it deliberately.
 *
 * Zero-dependency by design (mirrors `wireLimits.ts` and `unsafeKeys.ts`) so both middleware
 * packages and the client can import it with no risk of an import cycle.
 */

/** Version this build's client stamps on a `StudioAIRequest`. */
export const STUDIO_AI_WIRE_VERSION = 1;

/** Oldest AI-wire version a server built from this source will accept. */
export const MIN_SUPPORTED_STUDIO_AI_WIRE_VERSION = 1;

/** Version this build's client stamps on a `BatchQueryRequest`. */
export const STUDIO_DATA_WIRE_VERSION = 1;

/** Oldest data-wire version a server built from this source will accept. */
export const MIN_SUPPORTED_STUDIO_DATA_WIRE_VERSION = 1;

/** Which of the two wires a compatibility check concerns. */
export type StudioWireName = 'ai' | 'data';

/** Why a version was refused. Distinguished so a host can branch without parsing the message. */
export type StudioWireVersionRejection = 'absent' | 'malformed' | 'too-old' | 'too-new';

export type StudioWireVersionCheck =
  | { compatible: true; version: number }
  | { compatible: false; reason: StudioWireVersionRejection; received: unknown; message: string };

const WIRE_LABEL: Record<StudioWireName, string> = {
  ai: 'AI chat',
  data: 'batch query',
};

const WIRE_PACKAGE: Record<StudioWireName, string> = {
  ai: '@mui/x-studio-ai-middleware',
  data: '@mui/x-studio-data-middleware',
};

/**
 * Compare a received envelope version against what this build supports.
 *
 * Returns a result rather than throwing, because the two callers need different failure shapes:
 * the data middleware throws (it answers with a rejected HTTP request), while the AI middleware
 * emits an SSE `error` event (its response has already begun as a stream). Both build their
 * failure from the same `message`, so the two wires cannot drift in what they tell a host.
 * @param wire Which wire is being checked.
 * @param received The `protocolVersion` field as it arrived — deliberately `unknown`, since this
 *   is a trust boundary and the value may be absent or any JSON type.
 * @returns Whether the version is compatible, and if not, why and what to tell the host.
 */
export function checkStudioWireVersion(
  wire: StudioWireName,
  received: unknown,
): StudioWireVersionCheck {
  const current = wire === 'ai' ? STUDIO_AI_WIRE_VERSION : STUDIO_DATA_WIRE_VERSION;
  const minSupported =
    wire === 'ai' ? MIN_SUPPORTED_STUDIO_AI_WIRE_VERSION : MIN_SUPPORTED_STUDIO_DATA_WIRE_VERSION;
  const label = WIRE_LABEL[wire];
  const pkg = WIRE_PACKAGE[wire];
  const supported =
    minSupported === current ? `version ${current}` : `versions ${minSupported}–${current}`;

  if (received === undefined || received === null) {
    return {
      compatible: false,
      reason: 'absent',
      received,
      message:
        `MUI X Studio: The ${label} request carries no "protocolVersion", so it comes from a client older than ` +
        `wire versioning. This server speaks ${supported} and cannot tell which payload shape to expect. ` +
        `Upgrade @mui/x-studio to a build that stamps the version, or pin ${pkg} to the release that matches your client.`,
    };
  }
  if (typeof received !== 'number' || !Number.isInteger(received) || received < 0) {
    return {
      compatible: false,
      reason: 'malformed',
      received,
      message:
        `MUI X Studio: The ${label} request's "protocolVersion" is ${JSON.stringify(received)}, which is not a non-negative integer. ` +
        `The version is the first thing this handler reads, so an unreadable one leaves it unable to validate anything else safely. ` +
        `Send the integer exported as the wire version from @mui/x-studio-schema; this server speaks ${supported}.`,
    };
  }
  if (received < minSupported) {
    return {
      compatible: false,
      reason: 'too-old',
      received,
      message:
        `MUI X Studio: The ${label} request declares wire version ${received}, but this server speaks ${supported}. ` +
        `The older payload shape can no longer be served correctly, so answering it would return wrong data rather than an error. ` +
        `Upgrade @mui/x-studio to a build stamping ${minSupported} or later, or downgrade ${pkg} to match the client.`,
    };
  }
  if (received > current) {
    return {
      compatible: false,
      reason: 'too-new',
      received,
      message:
        `MUI X Studio: The ${label} request declares wire version ${received}, but this server speaks ${supported} — the client is NEWER than the server. ` +
        `The request may carry fields this server would silently ignore, which produces a dashboard rendered from an incomplete query rather than a visible failure. ` +
        `Upgrade ${pkg} to the release matching @mui/x-studio; this usually means a half-finished deployment.`,
    };
  }
  return { compatible: true, version: received };
}
