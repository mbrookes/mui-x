/**
 * Shared CSV cell escaping.
 *
 * A CSV downloaded from Studio is routinely opened in Excel / Google Sheets, which interpret any
 * cell whose text begins with `=`, `+`, `-`, `@`, tab or carriage return as a live formula. A label
 * sourced from user data such as `=HYPERLINK("http://evil","click")` therefore executes on open —
 * CSV formula injection. {@link escapeCsvCell} neutralizes that class of value while also applying
 * standard CSV quoting.
 */

// Tab (\t) and carriage return (\r) are legitimate formula-injection lead characters
// we must neutralize alongside `=`, `+`, `-`, `@`.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Escape a string for safe inclusion as a single CSV cell.
 *
 * - Prefixes a leading `=` / `+` / `-` / `@` / tab / CR with `'` so spreadsheet
 *   applications treat the cell as text, not a formula.
 * - Wraps the result in double quotes and doubles any embedded quote, so commas,
 *   quotes and newlines inside the value never break the row structure.
 *
 * Only apply this to text cells (labels, headers). Numeric cells must NOT be
 * escaped: a legitimate negative number like `-5` would otherwise be corrupted to
 * `'-5`.
 */
export function escapeCsvCell(value: string): string {
  const neutralized = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return `"${neutralized.replace(/"/g, '""')}"`;
}
