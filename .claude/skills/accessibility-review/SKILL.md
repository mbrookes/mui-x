---
name: accessibility-review
description: >-
  State-of-the-art accessibility (a11y) review for React / MUI / TypeScript UI
  code. Use when the user asks to audit, review, or fix accessibility, a11y,
  WCAG, ARIA, screen-reader, keyboard-navigation, or focus-management issues in
  components. Encodes WCAG 2.2 AA success criteria, the ARIA Authoring Practices
  Guide (APG) widget patterns, and a static-review methodology tuned for React.
---

# Accessibility Review

A repeatable, source-grounded methodology for reviewing UI code against
**WCAG 2.2 AA** and the **ARIA Authoring Practices Guide (APG)**. Optimized for
React + TypeScript codebases that use MUI (Material UI / MUI X), but the
criteria are framework-agnostic.

This skill is for **static (source-level) review**. It cannot replace a runtime
audit with axe-core / Lighthouse / a screen reader, so always flag findings that
require runtime confirmation as such.

## How to run a review

1. **Scope** – Enumerate the UI surface: every component that renders DOM,
   every interactive element, every custom widget (things built from `div`/
   `span` + handlers rather than native controls).
2. **Triage by interaction model** – For each component, classify it:
   - Native control wrapper (button, input, select, dialog) → check MUI usage is
     correct and not broken by overrides.
   - Custom ARIA widget (tablist, listbox, combobox, grid, slider, tree,
     menu, dialog, tooltip) → check it against the matching APG pattern below.
   - Static / presentational → check images, headings, landmarks, contrast.
3. **Apply the checklist** (below) to each, citing `file:line`.
4. **Classify severity**:
   - **Critical** – Blocks a user of an assistive technology entirely
     (keyboard trap, control with no accessible name, action only reachable by
     mouse, focus lost into the void).
   - **Serious** – Major barrier with a workaround (wrong role, missing state,
     poor focus order, non-semantic interactive element).
   - **Moderate** – Degraded experience (missing live region, redundant ARIA,
     contrast risk, missing `lang`/labels on optional fields).
   - **Minor** – Best-practice / polish.
5. **Report** – Group by severity, give the WCAG SC reference, the concrete
   fix, and a code-level pointer. Distinguish confirmed issues from
   "needs runtime verification".

## Core checklist (WCAG 2.2 AA)

### 1. Name, Role, Value (SC 4.1.2)
- Every interactive element exposes an **accessible name**. For icon-only
  buttons that means `aria-label`, `aria-labelledby`, or visually-hidden text —
  not just a tooltip (tooltips are not reliably announced and are mouse-hover
  oriented).
- Custom widgets expose a correct **role** and keep **state** in sync
  (`aria-expanded`, `aria-selected`, `aria-checked`, `aria-pressed`,
  `aria-disabled`, `aria-current`, `aria-invalid`).
- Don't put interactive handlers on non-interactive elements (`<div onClick>`)
  without role + `tabIndex={0}` + keyboard handler — prefer a real `<button>`.

### 2. Keyboard (SC 2.1.1 / 2.1.2 / 2.1.4)
- All functionality is operable by keyboard; no mouse-only actions
  (drag-and-drop, hover-only menus, click-only resize handles need a keyboard
  path or equivalent).
- No keyboard traps. Focus can always move out.
- Composite widgets implement APG keyboard support (arrow keys, Home/End,
  type-ahead, roving `tabIndex`).

### 3. Focus management (SC 2.4.3 / 2.4.7 / 2.4.11)
- Logical, visible focus order. Visible focus indicator never removed
  (`outline: none` without a replacement is a fail).
- Dialogs/drawers/popovers: focus moves in on open, is trapped while open,
  returns to the trigger on close. MUI `Dialog`/`Modal`/`Popover` do this; a
  hand-rolled overlay usually does not.
- Focus is never placed on or left inside an element that becomes hidden.
- SC 2.4.11 (new in 2.2): focused element not entirely hidden by sticky
  content.

### 4. Roles, landmarks & structure (SC 1.3.1)
- Use semantic HTML/landmarks (`main`, `nav`, `header`, `aside`) or ARIA
  landmark roles. Multiple same-type landmarks need distinguishing labels.
- Headings convey structure and don't skip levels arbitrarily.
- Lists use list semantics; tables use table semantics.

### 5. Forms & labels (SC 1.3.1 / 3.3.2 / 4.1.2)
- Every form control has a programmatically associated label
  (`<label htmlFor>`, `aria-label`, `aria-labelledby`). Placeholder is **not** a
  label.
- Error messages are associated (`aria-describedby`, `aria-invalid`) and
  announced.
- Required fields communicated non-visually.

### 6. Live regions & status (SC 4.1.3)
- Async updates, toasts, validation, loading and "no data" states that appear
  without focus change are announced via `aria-live` / `role="status"` /
  `role="alert"`.

### 7. Images & non-text (SC 1.1.1)
- Informative `<img>`/SVG have text alternatives; decorative ones are hidden
  (`alt=""`, `aria-hidden`, `role="presentation"`). Charts/maps/data-viz need a
  text summary or accessible data table.

### 8. Color & contrast (SC 1.4.1 / 1.4.3 / 1.4.11)
- Don't rely on color alone to convey information.
- Text contrast ≥ 4.5:1 (≥ 3:1 large); UI component / graphical-object contrast
  ≥ 3:1. (Flag for runtime/design verification — exact values need the rendered
  theme.)

### 9. Target size & pointer (SC 2.5.8)
- Interactive targets ≥ 24×24 CSS px (or spacing exception). Watch tiny
  icon buttons / drag handles / resize grips.

### 10. Motion, reflow, zoom (SC 1.4.10 / 2.3.3 / 1.4.4)
- Respect `prefers-reduced-motion`. Content reflows at 320px / 400% zoom.

## APG widget patterns (quick reference)

When a component implements one of these by hand, verify against the pattern:

- **Tabs** – `role="tablist"` > `role="tab"` (`aria-selected`,
  `aria-controls`, roving tabIndex); `role="tabpanel"` (`aria-labelledby`,
  focusable). Left/Right arrows move between tabs.
- **Dialog (modal)** – `role="dialog"` `aria-modal="true"`, labelled by title,
  focus trapped, Escape closes, focus restored.
- **Listbox / Select / Combobox** – correct roles, `aria-activedescendant` or
  roving focus, `aria-expanded` on the input, arrow-key navigation.
- **Menu / Menubar** – `role="menu"`/`menuitem`, arrow navigation, Escape
  closes and restores focus.
- **Slider** – `role="slider"`, `aria-valuemin/max/now`, `aria-valuetext` for
  formatted values, arrow/Home/End/PageUp/Down keys.
- **Tree** – `role="tree"`/`treeitem`, `aria-expanded`, arrow navigation.
- **Tooltip** – `role="tooltip"` referenced by `aria-describedby`; must be
  keyboard-reachable; not the only carrier of an accessible name.
- **Disclosure / Accordion** – trigger is a `<button aria-expanded>` controlling
  the region (`aria-controls`).
- **Data grid** – `role="grid"`, `aria-rowcount`/`colcount`, cell navigation.

## React / MUI specific traps

- `IconButton` with only an icon child → needs `aria-label`. A `Tooltip` wrapper
  does **not** supply the accessible name reliably.
- Overriding MUI focus styles (`'&:focus': { outline: 'none' }`,
  `disableFocusRipple`) can destroy the visible focus indicator.
- `<MenuItem onClick>` used as a button is fine; a `<div role="button">` is not
  unless it also handles Enter/Space and is focusable.
- Drag-and-drop (react-dnd / pointer DnD) is mouse-only by default — needs a
  keyboard-accessible alternative (reorder buttons, menu, or arrow handling).
- `Dialog`/`Drawer`/`Popover`/`Menu`/`Tooltip` from MUI bring focus management;
  custom absolutely-positioned panels usually don't.
- Charts (MUI X Charts / SVG): purely visual; pair with an `aria-label`,
  description, or an off-screen data table.
- `autoFocus`, `tabIndex` > 0, and `aria-hidden` on a focusable ancestor are
  common regressions.
- `key`-handler components: ensure both `onKeyDown` and the equivalent click
  path exist, and `preventDefault` for Space on custom buttons.

## Output format

Produce a Markdown report:

```
# Accessibility Review — <scope>

## Summary
<counts by severity, headline themes>

## Findings
### [SEVERITY] <short title> — <WCAG SC>
- **Where:** path/to/File.tsx:NN
- **Issue:** what's wrong and who it affects
- **Fix:** concrete remediation
- **Verify:** (if runtime confirmation needed)
```

Always cite real `file:line`. Never invent issues; if something only *might* be
a problem, say so and mark it for runtime verification.
