import * as React from 'react';
import { FormControl, FormControlLabel, FormLabel, Switch } from '@mui/material';
import type { StudioFeatureFlags } from '@mui/x-studio';

export const WIDGET_KIND_FLAGS: { key: keyof StudioFeatureFlags; label: string }[] = [
  { key: 'grid', label: 'Table' },
  { key: 'chart', label: 'Chart' },
  { key: 'kpi', label: 'KPI' },
  { key: 'text', label: 'Text' },
  { key: 'filter', label: 'Filter widget' },
  { key: 'pivot', label: 'Pivot table' },
  { key: 'map', label: 'Map' },
];

export const WIDGET_FEATURE_FLAGS: {
  key: keyof StudioFeatureFlags;
  label: string;
  parentKey?: keyof StudioFeatureFlags;
}[] = [
  { key: 'compose', label: 'Compose panel' },
  { key: 'filters', label: 'Filters panel' },
  { key: 'savedFilterViews', label: 'Saved filter views' },
  { key: 'dataManagement', label: 'Data management drawer' },
  { key: 'relationships', label: 'Relationships panel', parentKey: 'dataManagement' },
  { key: 'widgetFilters', label: 'Widget filters tab' },
  { key: 'aiChat', label: 'AI chat assistant' },
  { key: 'calculatedFields', label: 'Calculated fields (all)' },
  { key: 'kpiCalculatedFields', label: 'KPI calculated fields', parentKey: 'calculatedFields' },
  { key: 'chartCalculatedFields', label: 'Chart calculated fields', parentKey: 'calculatedFields' },
  { key: 'gridCalculatedFields', label: 'Table calculated fields', parentKey: 'calculatedFields' },
  { key: 'kpiSparkline', label: 'KPI sparkline', parentKey: 'kpi' },
  { key: 'kpiTrend', label: 'KPI trend indicator', parentKey: 'kpi' },
  { key: 'kpiTarget', label: 'KPI target line', parentKey: 'kpi' },
  { key: 'chartAnnotations', label: 'Chart annotations', parentKey: 'chart' },
  { key: 'gridGroupBy', label: 'Table group by', parentKey: 'grid' },
  { key: 'gridSummary', label: 'Table summary row', parentKey: 'grid' },
  { key: 'gridConditionalFormats', label: 'Table conditional formats', parentKey: 'grid' },
];

export interface FeatureFlagSettingsProps {
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
}

/**
 * Renders widget-kind and feature-flag toggle sections, shared between the
 * x-studio and x-studio-composed settings dialogs.
 */
export function FeatureFlagSettings(props: FeatureFlagSettingsProps) {
  const { featureFlags, onFeatureFlagsChange } = props;

  function handleFlagToggle(key: keyof StudioFeatureFlags, checked: boolean) {
    onFeatureFlagsChange({ ...featureFlags, [key]: checked });
  }

  return (
    <React.Fragment>
      <FormControl component="fieldset">
        <FormLabel component="legend" sx={{ mb: 0.5 }}>
          Widget types
        </FormLabel>
        {WIDGET_KIND_FLAGS.map(({ key, label }) => (
          <FormControlLabel
            key={key}
            control={
              <Switch
                size="small"
                checked={(featureFlags[key] as boolean | undefined) !== false}
                onChange={(_evt, checked) => handleFlagToggle(key, checked)}
              />
            }
            label={label}
          />
        ))}
      </FormControl>

      <FormControl component="fieldset">
        <FormLabel component="legend" sx={{ mb: 0.5 }}>
          Features
        </FormLabel>
        {WIDGET_FEATURE_FLAGS.map(({ key, label, parentKey }) => {
          const parentDisabled = parentKey
            ? (featureFlags[parentKey] as boolean | undefined) === false
            : false;
          return (
            <FormControlLabel
              key={key}
              control={
                <Switch
                  size="small"
                  checked={!parentDisabled && (featureFlags[key] as boolean | undefined) !== false}
                  disabled={parentDisabled}
                  onChange={(_evt, checked) => handleFlagToggle(key, checked)}
                />
              }
              label={label}
            />
          );
        })}
      </FormControl>
    </React.Fragment>
  );
}
