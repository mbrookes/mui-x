/**
 * Value-level validation for doc-authored CSS-ish config fields (finding 1).
 *
 * A handful of `StudioWidgetConfig` fields (the text widget's `text*Color` /
 * `text*FontFamily` / `text*FontSize` fields, and the analogous `pageTheme`/grid
 * conditional-format style fields) are interpolated directly into an Emotion `sx` prop
 * at render time. Emotion does NOT escape interpolated property values, so an
 * unvalidated string reaching `sx` can inject arbitrary CSS rules — e.g.
 * `textBodyFontFamily: "serif;} .MuiCard-root{background:url(https://evil/leak)"`.
 *
 * These config values are reachable from two untrusted entry points:
 *  - `loadSerializedState(data: unknown)` — a hostile/corrupted serialized dashboard.
 *  - The AI `update_widget` tool call — a value the model chose to write.
 *
 * Neither boundary does per-field VALUE validation today (the existing screening layer
 * in `@mui/x-studio-schema` — `internalGuards.ts`/`configKeyValidation.ts` — only checks
 * key PRESENCE and prototype-pollution-unsafe keys, not the shape of a given key's
 * value). Rather than teach that generic, kind-agnostic layer about specific fields'
 * semantics (color vs font vs size), these fields are validated here, at the point where
 * they are actually consumed and interpolated into `sx` — a value that fails validation
 * simply falls back to the default/unset behaviour instead of throwing, matching the
 * pattern every other optional style field in this render path already uses (`config.x
 * ?? default`).
 */

const supportsCssApi = typeof CSS !== 'undefined' && typeof CSS.supports === 'function';

// Fallback shape-check used when the `CSS` global (or `CSS.supports`) isn't available —
// e.g. this repo's jsdom-based unit test environment, which has no `CSS` global at all.
// Deliberately conservative: it only needs to reject values containing CSS/selector
// metacharacters (`;`, `{`, `}`, `:`, unexpected `(`/`)`), not to validate every possible
// valid CSS color syntax perfectly. A value that clears this shape-check but isn't a
// real color (e.g. a nonsense keyword) is a cosmetic no-op, not a security issue.
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_COLOR_PATTERN = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([\w\s.,%-]*\)$/;
const CSS_VAR_COLOR_PATTERN = /^var\(--[\w-]+(?:,\s*[\w\s.,%#-]*)?\)$/;
const NAMED_COLOR_PATTERN = /^[a-zA-Z]+$/;

function matchesSafeColorShape(value: string): boolean {
  return (
    HEX_COLOR_PATTERN.test(value) ||
    FUNCTIONAL_COLOR_PATTERN.test(value) ||
    CSS_VAR_COLOR_PATTERN.test(value) ||
    NAMED_COLOR_PATTERN.test(value)
  );
}

/**
 * Whether `value` is safe to interpolate as a CSS `color`/`background-color` value.
 *
 * Uses `CSS.supports('color', value)` when the runtime provides it (real browsers);
 * falls back to a conservative shape-check (see {@link matchesSafeColorShape}) in
 * environments without a `CSS` global (this package's jsdom unit-test environment).
 */
export function isSafeCssColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  const trimmed = value.trim();
  if (supportsCssApi) {
    try {
      return CSS.supports('color', trimmed);
    } catch {
      return false;
    }
  }
  return matchesSafeColorShape(trimmed);
}

/**
 * Returns `value` if it is a safe CSS color string, otherwise `fallback` (default
 * `undefined`). Use at every render-time call site that would otherwise pass a
 * doc-authored color string straight into an `sx`/style prop.
 */
export function sanitizeCssColor<T = undefined>(
  value: unknown,
  fallback?: T,
): string | T | undefined {
  return isSafeCssColor(value) ? value : fallback;
}

/**
 * Allow-list for a "literal CSS font-family" value: letters, digits, whitespace, commas,
 * quotes, and hyphens only — enough to express a normal comma-separated stack like
 * `Fraunces, "Inter Tight", serif`, but unable to terminate the declaration/rule it is
 * interpolated into (no `;`, `{`, `}`, `:`, `(`, `)`, `/`, or other syntax characters).
 */
const SAFE_FONT_FAMILY_PATTERN = /^[\w\s,'"-]+$/;

export function isSafeFontFamily(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && SAFE_FONT_FAMILY_PATTERN.test(value);
}

/**
 * Returns `value` if it is a finite number `>= min` (default `0`, i.e. non-negative),
 * otherwise `undefined`. Several `StudioPageTheme`/`StudioTextConfig` fields that are
 * interpolated into a numeric `sx` value (`fontSize`, `cardRadius`, `cardPadding`,
 * `cardBorderWidth`, …) are typed as `number`, but that type is not enforced at the
 * `loadSerializedState`/AI-tool-call boundary — a corrupted/hostile doc could carry a
 * non-numeric value (e.g. a CSS-injecting string) here too.
 */
export function sanitizeFiniteNumber(value: unknown, min: number = 0): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : undefined;
}

/**
 * Returns a finite, positive font size, or `undefined` if `value` isn't one. A thin,
 * more strongly-named wrapper over {@link sanitizeFiniteNumber} for font-size fields
 * specifically (font size `0` is meaningless, unlike e.g. a border width).
 */
export function sanitizeFontSize(value: unknown): number | undefined {
  return sanitizeFiniteNumber(value, 1);
}
