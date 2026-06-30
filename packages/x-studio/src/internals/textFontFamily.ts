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
 * `'Fraunces, "Inter Tight", serif'`. Returns `undefined` for an empty value so callers
 * fall back to the theme default.
 */
export function resolveTextFontFamily(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return NAMED_FONT_STACKS[value] ?? value;
}
