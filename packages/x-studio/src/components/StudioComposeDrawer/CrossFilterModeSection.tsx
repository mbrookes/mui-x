'use client';
import * as React from 'react';
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../context';
import type { StudioCrossFilterMode } from '../../models';
import { SetupSection } from './SetupSection';

const MODE_LOCALE_KEY = {
  'cross-highlight': 'crossFilterModeHighlight',
  'cross-filter': 'crossFilterModeFilter',
  none: 'crossFilterModeNone',
} as const satisfies Record<StudioCrossFilterMode, string>;

export interface CrossFilterModeSectionProps {
  /** The widget whose `crossFilterMode` config is being edited. */
  widgetId: string;
  /** Section heading (already localized by the caller — no locale keys move). */
  title: string;
  /** Optional helper text below the title (already localized by the caller). */
  description?: string;
  /**
   * Which mode buttons to render, in order. Chart/Grid pass all three
   * (`['cross-highlight', 'cross-filter', 'none']`); KPI passes only
   * `['cross-filter', 'none']` — KPIs are summary metrics with no per-row visual, so
   * "highlight" doesn't apply to them.
   */
  modes: StudioCrossFilterMode[];
  /**
   * The mode shown as selected when the stored config value is `undefined`. Chart/Grid/Map
   * pass `'cross-highlight'`; KPI passes `'none'`. It is NOT what a deselect commits — see
   * the `onChange` handler.
   */
  defaultMode: StudioCrossFilterMode;
  /** The raw, possibly-legacy `config.crossFilterMode` value. */
  value: StudioCrossFilterMode | undefined;
  /** Forwarded to `SetupSection` (Grid passes `0` to remove the section's bottom gap). */
  dividerMb?: number;
}

/**
 * Shared "Interactions" setup-panel section: a three-(or two-)way cross-filter-mode
 * toggle, used by `ChartSetupPanel`, `GridSetupPanel`, `KpiSetupPanel`, and
 * `MapSetupPanel` — previously hand-rolled independently in each.
 *
 * Normalizes the displayed value so a legacy-persisted `'cross-highlight'` value renders
 * as `'cross-filter'` selected on panels that don't offer "Highlight" (generalizing the
 * KPI panel's pre-existing legacy remap) — this is a display-only normalization; it does
 * NOT rewrite the stored config. It does not touch `StudioKpiWidget.tsx`'s
 * render-side `crossFilterMode` remap, which is a separate, still-necessary runtime
 * fallback for the same legacy values.
 */
export function CrossFilterModeSection(props: CrossFilterModeSectionProps) {
  const { widgetId, title, description, modes, defaultMode, value, dividerMb } = props;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  let displayValue: StudioCrossFilterMode;
  if (value !== undefined && modes.includes(value)) {
    displayValue = value;
  } else if (value === 'cross-highlight' && modes.includes('cross-filter')) {
    displayValue = 'cross-filter';
  } else {
    displayValue = defaultMode;
  }

  return (
    <SetupSection title={title} description={description} dividerMb={dividerMb}>
      <ToggleButtonGroup
        value={displayValue}
        exclusive
        onChange={(_e, next: StudioCrossFilterMode | null) => {
          // M16: an exclusive `ToggleButtonGroup` reports `null` when the user clicks the
          // ALREADY-SELECTED button. That is a deselect gesture, and these three modes have no
          // "nothing selected" state — so it means "no change", and the only correct response
          // is to ignore it. Mapping `null` to `defaultMode` (the previous behaviour, pinned
          // by two tests) made clicking the highlighted **None** on a chart commit
          // `'cross-highlight'` and silently switch cross-highlighting ON: the button the user
          // clicked to confirm their choice changed it to something else. Every sibling
          // exclusive group in the drawer — `SortDirectionToggle`, the funnel style toggle,
          // the mixed bar/line series toggle, the grid sort-direction toggle — already
          // ignores `null`; this was the one that did not.
          if (next === null) {
            return;
          }
          // `undefined` means "default", so compare against the RESOLVED current value: a
          // pick that lands back on the mode already in effect must not push an undo entry
          // whose content matches its predecessor.
          if (next === (value ?? defaultMode)) {
            return;
          }
          controller.updateWidgetConfig(widgetId, {
            crossFilterMode: next,
          });
        }}
        size="small"
        fullWidth
      >
        {modes.map((mode) => (
          <ToggleButton key={mode} value={mode} sx={{ fontSize: 11, textTransform: 'none' }}>
            {localeText[MODE_LOCALE_KEY[mode]]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </SetupSection>
  );
}
