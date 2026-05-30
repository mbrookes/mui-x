import * as React from 'react';
import { FormControl, FormControlLabel, FormLabel, Switch } from '@mui/material';
import type { StudioFeatureFlags } from '@mui/x-studio';

type NestedKindKey = 'kpi' | 'chart' | 'grid';

/** Returns true if the widget kind is enabled (flag is not `false`). */
function isKindEnabled(flags: StudioFeatureFlags, key: NestedKindKey): boolean {
  return flags[key] !== false;
}

/** Reads a sub-flag from a nested widget-kind flag. Defaults to `true`. */
function getSubFlag(flags: StudioFeatureFlags, parentKey: NestedKindKey, subKey: string): boolean {
  const parent = flags[parentKey];
  if (parent === false) return false;
  if (parent === undefined || parent === true) return true;
  return (parent as Record<string, boolean | undefined>)[subKey] ?? true;
}

/** Returns updated flags with a single sub-flag changed. */
function setSubFlag(
  flags: StudioFeatureFlags,
  parentKey: NestedKindKey,
  subKey: string,
  value: boolean,
): StudioFeatureFlags {
  const parent = flags[parentKey];
  const parentObj: Record<string, boolean> =
    parent === false || parent === undefined || parent === true
      ? {}
      : { ...(parent as Record<string, boolean>) };
  parentObj[subKey] = value;
  return { ...flags, [parentKey]: parentObj };
}

const KIND_LABELS: Record<string, string> = {
  grid: 'Table',
  chart: 'Chart',
  kpi: 'KPI',
  text: 'Text',
  filter: 'Filter widget',
  pivot: 'Pivot table',
  map: 'Map',
};

/** Top-level boolean flags (compose, filters, etc.) */
const TOP_LEVEL_FLAGS: {
  key: keyof StudioFeatureFlags;
  label: string;
  parentKey?: keyof StudioFeatureFlags;
}[] = [
  { key: 'compose', label: 'Compose panel' },
  { key: 'filters', label: 'Filters panel' },
  { key: 'savedFilterViews', label: 'Saved filter views', parentKey: 'filters' },
  { key: 'dataManagement', label: 'Data management drawer' },
  { key: 'relationships', label: 'Relationships panel', parentKey: 'dataManagement' },
  { key: 'widgetFilters', label: 'Widget filters tab' },
  { key: 'aiChat', label: 'AI chat assistant' },
  { key: 'calculatedFields', label: 'Calculated fields (all)' },
];

/** Sub-flags nested inside the kpi / chart / grid kind flags. */
const WIDGET_SUB_FLAGS: {
  parentKey: NestedKindKey;
  subKey: string;
  label: string;
  alsoRequires?: keyof StudioFeatureFlags;
}[] = [
  { parentKey: 'kpi', subKey: 'sparkline', label: 'KPI sparkline' },
  { parentKey: 'kpi', subKey: 'trend', label: 'KPI trend indicator' },
  { parentKey: 'kpi', subKey: 'target', label: 'KPI target line' },
  {
    parentKey: 'kpi',
    subKey: 'calculatedFields',
    label: 'KPI calculated fields',
    alsoRequires: 'calculatedFields',
  },
  { parentKey: 'chart', subKey: 'annotations', label: 'Chart annotations' },
  {
    parentKey: 'chart',
    subKey: 'calculatedFields',
    label: 'Chart calculated fields',
    alsoRequires: 'calculatedFields',
  },
  { parentKey: 'grid', subKey: 'groupBy', label: 'Table group by' },
  { parentKey: 'grid', subKey: 'summary', label: 'Table summary row' },
  { parentKey: 'grid', subKey: 'conditionalFormats', label: 'Table conditional formats' },
  {
    parentKey: 'grid',
    subKey: 'calculatedFields',
    label: 'Table calculated fields',
    alsoRequires: 'calculatedFields',
  },
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

  function handleSimpleToggle(key: keyof StudioFeatureFlags, checked: boolean) {
    onFeatureFlagsChange({ ...featureFlags, [key]: checked });
  }

  function handleKindToggle(key: keyof StudioFeatureFlags, checked: boolean) {
    if (!checked) {
      onFeatureFlagsChange({ ...featureFlags, [key]: false });
    } else {
      // Re-enable: remove the flag entirely so sub-flag defaults apply
      const updated = { ...featureFlags };
      delete updated[key];
      onFeatureFlagsChange(updated);
    }
  }

  function handleSubFlagToggle(parentKey: NestedKindKey, subKey: string, checked: boolean) {
    onFeatureFlagsChange(setSubFlag(featureFlags, parentKey, subKey, checked));
  }

  return (
    <React.Fragment>
      {/* Widget kind toggles */}
      <FormControl component="fieldset">
        <FormLabel component="legend" sx={{ mb: 0.5 }}>
          Widget types
        </FormLabel>
        {Object.keys(KIND_LABELS).map((key) => (
          <FormControlLabel
            key={key}
            control={
              <Switch
                size="small"
                checked={featureFlags[key as keyof StudioFeatureFlags] !== false}
                onChange={(_evt, checked) =>
                  handleKindToggle(key as keyof StudioFeatureFlags, checked)
                }
              />
            }
            label={KIND_LABELS[key]}
          />
        ))}
      </FormControl>

      {/* Top-level feature flags */}
      <FormControl component="fieldset">
        <FormLabel component="legend" sx={{ mb: 0.5 }}>
          Features
        </FormLabel>
        {TOP_LEVEL_FLAGS.map(({ key, label, parentKey }) => {
          const parentDisabled = parentKey ? featureFlags[parentKey] === false : false;
          return (
            <FormControlLabel
              key={key}
              control={
                <Switch
                  size="small"
                  checked={!parentDisabled && featureFlags[key] !== false}
                  disabled={parentDisabled}
                  onChange={(_evt, checked) => handleSimpleToggle(key, checked)}
                />
              }
              label={label}
            />
          );
        })}

        {/* Widget sub-flags (nested inside kpi / chart / grid) */}
        {WIDGET_SUB_FLAGS.map(({ parentKey, subKey, label, alsoRequires }) => {
          const kindDisabled = !isKindEnabled(featureFlags, parentKey);
          const alsoDisabled = alsoRequires ? featureFlags[alsoRequires] === false : false;
          return (
            <FormControlLabel
              key={`${parentKey}.${subKey}`}
              control={
                <Switch
                  size="small"
                  checked={
                    !kindDisabled &&
                    !alsoDisabled &&
                    getSubFlag(featureFlags, parentKey, subKey)
                  }
                  disabled={kindDisabled || alsoDisabled}
                  onChange={(_evt, checked) => handleSubFlagToggle(parentKey, subKey, checked)}
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
