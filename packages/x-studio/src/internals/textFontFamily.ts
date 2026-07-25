import { isSafeFontFamily } from './cssValueValidation';

const NAMED_FONT_STACKS: Record<string, string> = {
  'sans-serif': 'Arial, Helvetica, sans-serif',
  serif: "Georgia, 'Times New Roman', Times, serif",
  monospace: "'Courier New', Courier, monospace",
};

/**
 * Resolve a text-widget font-family config value to a CSS `font-family` stack.
 *
 * The three named keywords (`sans-serif` / `serif` / `monospace`) map to curated stacks;
 * any other value is treated as a literal CSS font-family, e.g.
 * `'Fraunces, "Inter Tight", serif'`, and is validated via {@link isSafeFontFamily} before
 * being returned. Returns `undefined` for an empty, non-string, or invalid value so callers
 * fall back to the theme default rather than rendering (or throwing on) an unsafe literal.
 *
 * Security note (finding 1): this config value comes from `StudioDoc.widgets[id].config`,
 * which is reachable via `loadSerializedState(data: unknown)` (an untrusted serialized
 * dashboard) and the AI `update_widget` tool call — neither is otherwise value-validated
 * before reaching Emotion's `sx` prop, which does not escape interpolated property values.
 * Without the {@link isSafeFontFamily} allow-list, a value like
 * `serif;} .MuiCard-root{background:url(https://evil/leak)` would inject arbitrary CSS
 * rules into the page (UI-spoofing / limited-exfiltration risk).
 */
export function resolveTextFontFamily(value: string | undefined): string | undefined {
  if (!value || typeof value !== 'string') {
    return undefined;
  }
  // `value` is doc/AI-authored (see security note above), so guard the record index against
  // inherited keys: a value like "constructor" would otherwise resolve `NAMED_FONT_STACKS[value]`
  // to the inherited `Object` constructor (truthy) and return it directly as the "safe" font
  // family, bypassing the `isSafeFontFamily` allow-list check entirely.
  if (Object.hasOwn(NAMED_FONT_STACKS, value)) {
    return NAMED_FONT_STACKS[value];
  }
  return isSafeFontFamily(value) ? value : undefined;
}
