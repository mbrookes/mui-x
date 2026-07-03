# Widget config panel UX review

Findings from an automated visual review of the compose-drawer setup panels
(`packages/x-studio/src/components/StudioComposeDrawer/*SetupPanel.tsx`), covering
all 7 built-in widget kinds (Chart, Grid, KPI, Map, Pivot, Filter, Text).

## Method

- 51 screenshot fixtures were captured with a dedicated Playwright harness
  (`test/e2e-studio/setupPanelScreenshots.spec.ts`, scenarios defined in
  `examples/x-studio/src/screenshotScenarios.ts`), covering settled/filled states,
  empty states, error/warning states, and in-edit states (open dropdowns, menus,
  tooltips, dialogs).
- The screenshots were reviewed by 8 parallel model passes (one per panel, Chart
  split into settled vs. interactive states) plus one cross-cutting synthesis pass
  comparing a representative screenshot from each panel against the others.
- Every finding below is grounded in what a reviewer actually saw in a captured
  screenshot — nothing here is speculative. Re-run the harness and re-open the
  cited screenshot under `test/e2e-studio/screenshots/setup-panels/<panel>/<id>.png`
  to verify any finding (this directory is gitignored — regenerate it locally with
  `pnpm --filter x-studio-example dev` + the Playwright spec above).

## Cross-cutting findings (highest priority — one fix resolves many panels)

These recur across 3+ panels, meaning the fix belongs in a shared component or
convention, not a per-panel patch.

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                     |
| :-- | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **High** | `DataSourceFieldSelect` shows a dropdown caret when empty but only a clear (×) button once filled, in every panel that uses it (Chart, KPI, Map, Pivot, Filter). Changing an already-set field requires clearing it first — a different interaction model from every other select in the same panels.                        | Keep the caret visible (or clickable) in the filled state so the field can be swapped without clearing first — this is the single highest-value structural fix since it's the most-used shared primitive.                               |
| 2   | **High** | Three incompatible label systems coexist: standard MUI floating outlined labels, placeholder-only "ghost" labels that disappear once a value is chosen, and external bold section headings (Map even duplicates a label as both a heading and a placeholder).                                                                | Standardize on one convention (floating outlined label, persistent whether filled or empty) and sweep all seven panels.                                                                                                                 |
| 3   | **High** | The "nothing configured yet" state gets four different treatments across panels: info alert (Grid, Filter), plain intro paragraph (Pivot), inline italic note only for one sub-feature (Chart annotations), or nothing at all (KPI, Map) — required-but-empty fields look identical to optional ones.                        | Define one shared empty/required-state pattern and apply it everywhere; add a required indicator to blocking fields.                                                                                                                    |
| 4   | **High** | The cross-filter "Interactions" feature is a 3-option toggle in Chart (Highlight/Filter/None), a 2-option toggle in KPI (Filter/None), and two independently-worded switches in Map ("Clickable (filter source)" / "Respond to cross-filters") — same feature, three different controls and vocabularies.                    | Extract one shared Interactions component and reuse it across Chart, Grid, KPI, and Map; hide options that don't apply rather than inventing new switches.                                                                              |
| 5   | **High** | The ~220px drawer width breaks copy everywhere, with no consistent overflow handling: hard mid-word clipping with no ellipsis (Grid's "Select a data sou", Filter's Max/Step values rendering as "1("), inconsistent ellipsis truncation elsewhere. Critical values and qualifiers are unreadable in at least 5 of 7 panels. | Adopt one rule: labels/descriptions are written to fit the width (long qualifiers move to wrapping helper text), values always ellipsize with a tooltip revealing the full text, numeric inputs get a minimum width fitting 4–5 digits. |
| 6   | Medium   | The Aggregation control's position, default value, and enabled/disabled logic differ across Chart, KPI, Map (disabled, defaults to Count) vs. Pivot (enabled, defaults to Sum, no helper text).                                                                                                                              | Standardize position, default, and disabled-state logic; give Pivot's Aggregation the same helper-text treatment as its neighbors.                                                                                                      |
| 7   | Medium   | Grid and KPI show an explicit "Data source" picker; Chart, Map, Pivot, and Filter don't — the first configuration step differs per widget kind with no visual cue.                                                                                                                                                           | Needs a product decision (explicit vs. implicit source-selection model) rather than a pure bug fix — flagged here, not triaged as quick/structural.                                                                                     |
| 8   | Medium   | UK/US spelling is mixed across panels (Map's "Colour scheme", KPI's "Invert colours" vs. Chart scatter's "Color by").                                                                                                                                                                                                        | Copy sweep to one spelling (recommend US, matching MUI's own API conventions); consider a lint rule grepping for "colour".                                                                                                              |
| 9   | Medium   | Switch-row layout has no shared convention — KPI right-aligns the switch, Map/Pivot/Text place it before the label, and long labels wrap awkwardly under the thumb in Map/Pivot but not KPI/Text.                                                                                                                            | One shared switch-row component with a reserved, wrap-safe text column.                                                                                                                                                                 |
| 10  | Medium   | Helper-text placement/punctuation/presence is inconsistent (Map places it above the control instead of below; punctuation varies; Filter's "Field" picker has none at all).                                                                                                                                                  | One helper-text rule (position, punctuation, always-present) swept across all panels.                                                                                                                                                   |
| 11  | Medium   | Disabled controls never explain why they're locked, in any panel (KPI's Sparkline/Trend/Date-range sections, Map's Aggregation, Chart's Aggregation/Split-by).                                                                                                                                                               | One shared "why is this disabled" convention (tooltip or helper line stating the unlock condition), implemented once.                                                                                                                   |
| 12  | Medium   | The shared light-grey helper-text color appears to fall below WCAG 4.5:1 contrast in every panel, not just the ones flagged individually.                                                                                                                                                                                    | Fix once at the token level; verify with an automated contrast check.                                                                                                                                                                   |
| 13  | Low      | The measure/value concept has a different noun per panel ("Value field" in KPI/Map/Pivot, "Y / Measure field" in Chart, just "Field" in Filter); same for the category/dimension concept.                                                                                                                                    | Needs a product/IA decision on canonical vocabulary — flagged, not triaged.                                                                                                                                                             |

## Per-panel findings

### Chart (`ChartSetupPanel.tsx`) — 32 findings, highest-severity subset below

- **High** — Pie, donut, and funnel reuse cartesian labels/helpers ("X / Category
  field", "Groups data along the horizontal axis") that are factually wrong for
  those chart types (`chart-pie-basic`, `chart-donut-fieldless-count`, `chart-funnel`).
- **High** — In the fieldless-Count state, the disabled "Split by" reason text
  ("Not available when multiple measure fields are configured") is simply false —
  there are zero measure fields, not multiple (`chart-bar-fieldless-count`,
  `chart-donut-fieldless-count`).
- **High** — Annotation rows are too cramped to read: Label input shows "Targe…",
  a bare unlabeled "Y" control with no visible meaning (`chart-annotations`).
- **High** — The "unsupported combination" warning banner never names the
  offending field, and the bad field's chip renders with no error styling
  (`chart-unsupported-combo`).
- **High** — Once a field has a value, the field picker becomes a read-only chip
  with no way to reopen it short of clearing (see cross-cutting #1) —
  (`chart-x-field-select-open`).
- Medium/low findings: gauge vs. bar/line Aggregation-control inconsistency, funnel's
  Sort-by controls contradicting its own helper text, Gantt allowing identical
  start/end fields with no warning, the mixed-chart dual-axis checkbox being
  meaningless with no line series configured, an unlabeled "Group by" select,
  two near-identical "×" affordances (clear field vs. remove series) sitting next
  to each other, low-contrast toggle-button text, an icon-only 19-tile chart-type
  grid with several near-identical glyphs, heatmap's two axes using mismatched
  naming/helper-length conventions, inconsistent color/colour spelling, ALL-CAPS
  vs. sentence-case toggle labels, "Category field" naming the same concept twice
  in one panel, a disabled "+" add-series button with no explanatory tooltip.

### Grid (`GridSetupPanel.tsx`) — 12 findings

- **High** — Column list rows truncate the column name to a single character
  ("O", "D", "T.") because drag handle + icon + move arrows + kebab menu consume
  nearly the whole row width (`grid-with-columns`).
- Medium — The "Add column" menu's source-group headers appear to render blank/
  invisible — a real rendering bug worth root-causing, not just a copy fix
  (`grid-add-column-menu-open`).
- Medium — The column options menu mixes a destructive "Remove" with an
  unlabeled aggregation radio group and no indication aggregation only matters
  when Group-by is set (`grid-column-options-menu-open`).
- Medium — Terminology flips between "column" and "field" across one flow (menu
  says "Calculated column…", dialog says "New Calculated Field", button says
  "ADD FIELD") (`grid-calculated-column-dialog-open`).
- Medium — The calculated-column dialog's Operator row visually reads as one
  control when it's two, and the Input row is clipped behind the sticky footer
  with no scroll affordance (`grid-calculated-column-dialog-open`).
- Medium — Default-sort direction icon-only buttons have no text label; the
  Interactions segmented control's unselected options are low-contrast
  (`grid-with-columns`).
- Low/medium — Move-up/down disabled state isn't applied symmetrically at the
  list boundaries; the "Add column" and "Data source" placeholders clip mid-word;
  the empty state repeats the same instruction twice with different verbs
  ("Choose" vs. "Select"); the calculated-field "Output type" chip has no
  indication of whether it's editable.

### KPI (`KpiSetupPanel.tsx`) — 12 findings

- Medium — The Interactions description is truncated to "…this KPI…" in every
  state, so its explanation is never fully readable (`kpi-empty`).
- Medium — Sparkline/Trend sections can be toggled on with required sub-fields
  (Time field, Trend window) left empty and no error/required indication
  (`kpi-sparkline-expanded`, `kpi-trend-expanded`).
- Medium — Within one expanded section, some selects use placeholder-only labels
  and others use floating labels — two conventions side by side
  (`kpi-sparkline-expanded`).
- Medium — The "Date range" name is used for both the section title and the
  inner preset select — redundant and ambiguous (`kpi-date-range-expanded`).
- Medium — A floating label renders clipped/faint at the top edge of the
  expanded section container (`kpi-date-range-expanded`).
- Low — Truncated "Previous peri…" value text; a disabled Aggregation
  pre-filled with "Count" that silently changes to "Sum" once a field is picked,
  with no explanation; "None" segment in Filter/None toggle reads as disabled
  rather than selected; UK spelling in "Invert colours"; low-contrast helper text.

### Map (`MapSetupPanel.tsx`) — 8 findings

- **High** — The Value-field label is truncated to "Value field (optional for…"
  in every state — its qualifying explanation is never fully readable
  (`map-basic`).
- Medium — Colour-scheme options (Blues/Reds/Greens/Oranges/Purples) are plain
  text with no swatch/gradient preview, forcing a blind pick for a choropleth
  palette (`map-color-scheme-select-open`).
- Medium — The required Country field carries no required indicator or
  validation feedback (`map-empty`).
- Medium — Same filled-field-loses-caret issue as the cross-cutting #1 finding.
- Medium — "Country field" is shown as both an external heading and a duplicate
  internal floating label (`map-empty`, `map-basic`).
- Low — Disabled Aggregation has no explanation; the two cross-filter switches
  use mismatched terminology; clear-icon touch targets appear under 24×24px;
  UK spelling in "Colour scheme".

### Pivot (`PivotSetupPanel.tsx`) — 7 findings

- Medium — Selecting Count silently unmounts the Value-field picker with no
  explanation of why the (possibly already-filled) control disappeared
  (`pivot-count-hides-value-field`).
- Medium — Same filled-field-loses-caret issue as cross-cutting #1
  (`pivot-basic`).
- Medium — No required-state feedback in the empty state; helper text appears
  to be below contrast requirements (`pivot-empty`).
- Low — "Show totals row and column" switch label wraps awkwardly under the
  thumb; Aggregation is the only control in the panel with no helper text;
  small/low-contrast clear buttons and field-type glyphs; selected menu item
  indicated by color alone.

### Filter (`FilterSetupPanel.tsx`) — 7 findings

- **High** — Slider Max/Step inputs are too narrow to display their own
  committed values — both clip to "1(" (`filter-slider`).
- Medium — Every closed control-type select's second-line description is
  hard-clipped mid-word with no ellipsis, only readable while the menu is open
  (`filter-control-type-select-open` vs. settled states).
- Medium — The field-type prefix icon is low-contrast, likely imperceptible to
  low-vision users (`filter-multi-select`).
- Low — Small clear-button touch targets; inconsistent option-description
  phrasing across control types; the slider-range caption breaks mid-word and
  has weak visual association with its inputs; the "select a field" alert is
  the only required-state cue, with nothing on the control itself.

### Text (`TextSetupPanel.tsx` + `TextFormatPanel.tsx`) — 5 findings

- Medium — Enabling AI mode silently removes the Subtitle field and swaps Body
  for a Prompt field with no indication of what happened to existing content
  (`text-ai-mode`).
- Medium — The AI-mode switch — the control with the largest effect on the
  form — is the only control in the panel with no helper text (`text-plain`).
- Low — Multiline field sizing/layout jumps between AI-mode states; helper-text
  punctuation style differs between the Body and Prompt variants of the same
  slot; "supports plain text" is ambiguous about whether markdown is accepted.

## Phase 3 — remediation triage

### Quick fixes (single file or single string change, low risk, do first)

Status after implementation: 7 fixed, 1 not a real bug (verified against the
screenshot and reverted from the plan), 1 skipped as a false-premise fix (would
require hardcoding a non-themeable color into the component library to chase a
value that's already MUI's own default and technically passes WCAG AA).

1. ✅ **Fixed.** Chart: corrected the "Split by disabled" reason text for the
   fieldless-Count case — it previously claimed "multiple measure fields" with
   zero fields set. Also fixed the matching tooltip, which had the same bug.
2. ✅ **Fixed.** Chart: pie/donut now show "Slice category" / "Slice value"
   and funnel shows "Stage field", replacing the cartesian "X / Category
   field" / "Y / Measure field" wording (funnel's Y-field was already
   correctly labeled "Value field" — only its X-field label needed fixing).
3. ❌ **Not a bug — verified and skipped.** Re-reading `GridSetupPanel.tsx`,
   the move-up/move-down disabled logic (`disabled={index === 0}` /
   `disabled={index === length - 1}`) was already correct. The screenshot
   shows both boundary buttons visibly grayed; this looks like the reviewing
   model misjudging MUI's subtle disabled-icon contrast in a downscaled image,
   not a real defect. Left untouched.
4. ✅ **Fixed (as a helper-text addition, not a behavior change).** The
   pre-filled "Count" is intentional — documented in the code as the only
   valid aggregation with no value field, and changing it to an empty
   placeholder would be a UX regression (less informative), not a fix. Instead
   added a `FormHelperText` explaining the lock ("Counts rows — pick a value
   field to sum, average, etc.").
5. ✅ **Fixed.** Grid: removed the redundant Autocomplete helper text now that
   the info alert below it says the same thing.
6. ✅ **Fixed.** Swept every user-visible "colour" string in
   `StudioUIConfigContext.ts`'s English defaults to "color" (10 values across
   Chart/KPI/Map/page-config strings). Left the internal locale _key names_
   (e.g. `mapSetupColourSchemeLabel`) unchanged — they're invisible to users
   and renaming them would be pure churn.
7. ✅ **Fixed.** Added `sx={{ textTransform: 'none' }}` to every
   `ToggleButton` that was missing it (Chart's sort-direction ×2, funnel
   filled/outlined, mixed-chart bar/line) so all toggle groups render in
   sentence case, matching the Interactions toggles that already had it.
   Grid's sort-direction toggle and Text's alignment toggles are icon-only
   (no text label) — casing doesn't apply to them, left as-is.
8. ❌ **Skipped — false premise.** Checked whether the demo theme overrides
   `text.secondary`; it doesn't. The color in question is plain MUI default
   (~4.6:1 contrast, technically AA-passing for normal text), used consistently
   across 25 call sites in 15 files. Hardcoding a different literal color into
   a themeable component library to chase a compliant default would break dark
   mode and white-labeling for every consumer. If this still reads as "too
   light" in practice, the fix belongs in the _consuming app's_ theme
   (`text.secondary` override), not in x-studio's component source.
9. ✅ **Fixed.** Filter: Min/Max/Step now stack vertically (each `fullWidth`)
   instead of sharing one cramped row — committed values are fully readable.

All fixes verified against `test/e2e-studio/setupPanelScreenshots.spec.ts`
re-runs of the affected scenarios, plus the full x-studio jsdom suite (1543
tests, all passing) and typecheck.

### Structural (shared component work, higher impact, sequence after quick fixes)

1. ✅ **Fixed.** **`DataSourceFieldSelect` filled-state caret** (cross-cutting
   #1) — the single highest-value fix; touches Chart, KPI, Map, Pivot, Filter
   at once. The component had two entirely separate render branches: an
   editable `Autocomplete` when empty, and a static read-only `TextField` with
   only a clear button once filled — the latter is what made filled fields
   un-reopenable without clearing first. Merged into one always-editable
   `Autocomplete`, keeping the field-type icon as a `startAdornment` and
   wiring the localized clear-button text (`dataSourceClearFieldAriaLabel`,
   previously unused after removing the manual clear button) into
   Autocomplete's own `clearText` prop.
   Fixing this surfaced a second, related bug: the merged Autocomplete's
   closed-state text reused `getOptionLabel`, which prefixes every option with
   its source name ("Orders · Department") whenever a field list spans more
   than one source — even when there's no actual name collision to
   disambiguate. That made the already-narrow drawer's resting values longer
   than before, not just restore-length. Tightened the qualification to fire
   only when two sources genuinely share a field label (`hasAmbiguousLabels`,
   replacing the old `hasMultipleSources` check), so an unambiguous field like
   "Department" now again shows as just "Department" at rest, while a real
   collision (e.g. two "Country" fields) would still get the qualified label.
   Verified via the full x-studio suite (1543 tests, still all passing),
   typecheck, and re-captured screenshots — including a new
   `chart-x-field-reopen-when-filled` scenario added specifically to prove a
   filled field reopens on click instead of requiring clear-first.
2. **Unify the label system** (cross-cutting #2) — pick floating-outlined-label
   as the standard and sweep all panels; do this after #1 since both touch the
   same picker component.
3. **Shared Interactions component** (cross-cutting #4) — replace Map's switch
   pair and unify Chart/KPI's toggle option sets.
4. **Shared empty/required-state pattern** (cross-cutting #3) — one component
   used by KPI, Map, Pivot, Chart's per-field empty states.
5. **Shared "why is this disabled" convention** (cross-cutting #11) — pairs
   naturally with #4.
6. **Chart form should relabel/reshape per chart type** — the pie/donut/funnel
   mislabeling and the "type picker changed but form still shows bar-chart
   controls" finding are the same root cause: field slots need a per-chart-type
   label/helper lookup, not hardcoded cartesian copy.
7. Grid calculated-column dialog: make the body scrollable above a sticky
   footer so the Input row is never clipped.
8. Grid "Add column" menu: root-cause the apparently-blank source-group headers.
9. Panel-width text-overflow policy (cross-cutting #5) — a design-system rule
   (ellipsis + tooltip, minimum numeric-input width) applied across all panels.

### Needs a product/design decision (flagged, not triaged as a straightforward fix)

- Whether every panel should have an explicit "Data source" picker (Grid/KPI
  today) or none (Chart/Map/Pivot/Filter today) (cross-cutting #7).
- Canonical vocabulary for the measure/value and category/dimension concepts,
  currently named differently per panel (cross-cutting #13).

## Suggested next step

Re-run the affected slice of the screenshot harness after each structural fix
and diff against the originals here — that gives a before/after artifact per
fix rather than a claim that it's fixed, closing the loop this review opened.
