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
   * The mode used when the stored config value is `undefined`, AND the value committed
   * when the user deselects the currently-selected button (an exclusive
   * `ToggleButtonGroup` reports `null` on deselect). Chart/Grid pass `'cross-highlight'`;
   * KPI passes `'none'`.
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
          // An exclusive `ToggleButtonGroup` reports `null` when the user deselects the current
          // button; resolve that (and any explicit pick) to a concrete mode. Guard against an
          // undoable no-op: deselecting the already-default button (or re-picking the current
          // mode) resolves to the value already in effect. `undefined` means "default", so
          // compare against the resolved current value before committing a new config key.
          const resolvedNext = next ?? defaultMode;
          if (resolvedNext === (value ?? defaultMode)) {
            return;
          }
          controller.updateWidgetConfig(widgetId, {
            crossFilterMode: resolvedNext,
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
