import * as React from 'react';
import { Box, Checkbox, FormControl, FormControlLabel, FormLabel } from '@mui/material';
import type { StudioFeatureFlags } from '@mui/x-studio';

type NestedKindKey = 'kpi' | 'chart' | 'grid';

/** Reads a sub-flag from a nested widget-kind flag. Defaults to `true`. */
function getSubFlag(flags: StudioFeatureFlags, parentKey: NestedKindKey, subKey: string): boolean {
  const parent = flags[parentKey];
  if (parent === false) {return false;}
  if (parent === undefined || parent === true) {return true;}
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

/**
 * Top-level boolean flags.
 * Children are rendered indented under their parent flag.
 */
const TOP_LEVEL_FLAGS: {
  key: keyof StudioFeatureFlags;
  label: string;
  parentKey?: keyof StudioFeatureFlags;
}[] = [
  { key: 'compose', label: 'Compose panel' },
  { key: 'filters', label: 'Filters panel' },
  { key: 'quickFilter', label: 'Quick filter bar' },
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

/** Renders a single Checkbox row, optionally indented for visual nesting. */
function FlagRow({
  label,
  checked,
  disabled,
  indented,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  indented?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Box sx={indented ? { ml: 3 } : undefined}>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={checked}
            disabled={disabled}
            onChange={(_evt, val) => onChange(val)}
          />
        }
        label={label}
        sx={disabled ? { opacity: 0.5 } : undefined}
      />
    </Box>
  );
}

export interface FeatureFlagSettingsProps {
  featureFlags: StudioFeatureFlags;
  onFeatureFlagsChange: (flags: StudioFeatureFlags) => void;
}

/**
 * Renders widget-kind and feature-flag toggle sections, shared between the
 * x-studio and x-studio-composed settings dialogs.
 * Child flags are visually indented under their parent and disabled when the
 * parent is off (preserving but ignoring their stored value).
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
      {/* Widget kind toggles with sub-flags nested beneath */}
      <FormControl component="fieldset">
        <FormLabel component="legend" sx={{ mb: 0.5 }}>
          Widget types
        </FormLabel>
        {Object.keys(KIND_LABELS).map((key) => {
          const kindEnabled = featureFlags[key as keyof StudioFeatureFlags] !== false;
          const subFlags = WIDGET_SUB_FLAGS.filter((sf) => sf.parentKey === key);
          return (
            <React.Fragment key={key}>
              <FlagRow
                label={KIND_LABELS[key]}
                checked={kindEnabled}
                disabled={false}
                onChange={(checked) => handleKindToggle(key as keyof StudioFeatureFlags, checked)}
              />
              {subFlags.map(({ subKey, label, alsoRequires }) => {
                const alsoDisabled = alsoRequires ? featureFlags[alsoRequires] === false : false;
                const disabled = !kindEnabled || alsoDisabled;
                return (
                  <FlagRow
                    key={`${key}.${subKey}`}
                    label={label}
                    checked={!disabled && getSubFlag(featureFlags, key as NestedKindKey, subKey)}
                    disabled={disabled}
                    indented
                    onChange={(checked) =>
                      handleSubFlagToggle(key as NestedKindKey, subKey, checked)
                    }
                  />
                );
              })}
            </React.Fragment>
          );
        })}
      </FormControl>

      {/* Top-level feature flags with children nested beneath their parent */}
      <FormControl component="fieldset">
        <FormLabel component="legend" sx={{ mb: 0.5 }}>
          Features
        </FormLabel>
        {TOP_LEVEL_FLAGS.map(({ key, label, parentKey }) => {
          const parentDisabled = parentKey ? featureFlags[parentKey] === false : false;
          const isChild = Boolean(parentKey);
          return (
            <FlagRow
              key={key}
              label={label}
              checked={!parentDisabled && featureFlags[key] !== false}
              disabled={parentDisabled}
              indented={isChild}
              onChange={(checked) => handleSimpleToggle(key, checked)}
            />
          );
        })}
      </FormControl>
    </React.Fragment>
  );
}
