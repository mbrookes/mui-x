'use client';
/* eslint-disable react/no-unused-prop-types */
import * as React from 'react';
import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { Studio } from './Studio';
import type { StudioHandle, StudioProps } from './Studio';
import type {
  StudioDataSourceAdapter,
  StudioFeatureFlags,
  StudioState,
  StudioCustomWidgetDef,
} from '../../models';
import type { StudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioMapGeographyDefinition } from '../widgets/StudioMapWidget/geographyLoaders';

/**
 * Props for `StudioDashboard` — the embed-first entry point to Studio.
 *
 * Use `StudioDashboard` when you want to display a pre-built dashboard with live data
 * but don't need the full authoring UI.  For building and editing dashboards, use `Studio`.
 *
 * @example
 * ```tsx
 * <StudioDashboard
 *   config={myDashboardConfig}
 *   dataAdapters={{ orders: ordersAdapter, customers: customersAdapter }}
 * />
 * ```
 */
export interface StudioDashboardProps {
  /**
   * Pre-built dashboard configuration (pages, widgets, data sources, relationships, filters).
   * This is the value returned by `Studio` ref's `getState()` or `serializeState()`.
   *
   * When this prop changes (by reference), the dashboard is reloaded with the new config.
   * Changes the user makes to filters while viewing are **not** propagated back — the
   * dashboard is always reset to the provided `config` when the prop updates.
   */
  config: StudioState;
  /**
   * Map of source ID → async data adapter.
   * Adapters are registered automatically whenever the component mounts or the map changes.
   *
   * Each adapter is an object with a `fetchRows` method (see `StudioDataSourceAdapter`).
   * When a source does not have an adapter, it falls back to the static `rows` data baked
   * into the `config` (useful for small reference tables or demo data).
   *
   * @example
   * ```tsx
   * const adapters = {
   *   orders: {
   *     async fetchRows(descriptor) {
   *       const res = await fetch(`/api/orders?${serializeDescriptor(descriptor)}`);
   *       return res.json();
   *     },
   *   },
   * };
   * ```
   */
  dataAdapters?: Record<string, StudioDataSourceAdapter>;
  /**
   * Called whenever the Studio state changes (e.g. user changes a filter).
   * The full state is passed; use `state.filters` to extract active filters.
   */
  onStateChange?: StudioProps['onStateChange'];
  /**
   * Runtime feature flags.
   *
   * `StudioDashboard` defaults to a **view-only** mode:
   * - `compose: false` — no compose drawer or edit mode toggle
   * - `dataManagement: false` — no data drawer
   *
   * Override any flag to re-enable features:
   * ```tsx
   * <StudioDashboard featureFlags={{ compose: true }} />   // allow editing
   * ```
   */
  featureFlags?: StudioFeatureFlags;
  /**
   * Locale text overrides. Pass a full translation object or a partial override.
   */
  localeText?: Partial<StudioLocaleText>;
  /**
   * Canvas width (in px) below which all widgets stack to full width.
   * @default 600
   */
  stackBreakpoint?: number;
  /**
   * Side of the canvas the filter panel is anchored to.
   * @default 'left'
   */
  sidebarSide?: 'left' | 'right';
  /**
   * Consumer-defined custom widget kinds shown alongside built-in widgets in the widget picker.
   * @see StudioCustomWidgetDef
   */
  customWidgets?: StudioCustomWidgetDef[];
  /**
   * Additional map geography definitions to register alongside the built-in `'world'`,
   * `'usa'`, and `'europe'` geographies.
   * @see Studio.geographies for full documentation.
   */
  geographies?: Record<string, StudioMapGeographyDefinition>;
  /**
   * System prop that allows defining system overrides and additional CSS styles applied to the
   * root element. Accepts valid CSS properties and MUI system values.
   */
  sx?: SxProps<Theme>;
}

const DEFAULT_EMBED_FLAGS: StudioFeatureFlags = {
  compose: false,
  dataManagement: false,
};

/**
 * Embed-first Studio component.
 *
 * Renders a pre-built dashboard with live data adapters in view-only mode by default.
 * The authoring UI (compose drawer, data drawer) is hidden unless explicitly enabled
 * via `featureFlags`.
 *
 * @see `Studio` for the full authoring component.
 */
export const StudioDashboard = React.memo(
  React.forwardRef<StudioHandle, StudioDashboardProps>(function StudioDashboard(props, ref) {
    const {
      config,
      dataAdapters,
      onStateChange,
      featureFlags,
      localeText,
      stackBreakpoint,
      sidebarSide,
      customWidgets,
      geographies,
      sx,
    } = props;

    // Merge caller-supplied flags on top of view-only defaults

    const mergedFlags = React.useMemo<StudioFeatureFlags>(
      () => ({ ...DEFAULT_EMBED_FLAGS, ...featureFlags }),
      [featureFlags],
    );

    const innerRef = React.useRef<StudioHandle>(null);

    // Expose the underlying handle to the caller's ref
    React.useImperativeHandle(ref, () => innerRef.current!, []);

    // Load new config whenever the prop reference changes.
    // We compare by reference (not deep equality) to avoid unnecessary reloads.
    const prevConfigRef = React.useRef<StudioState | null>(null);
    React.useEffect(() => {
      if (prevConfigRef.current !== null && prevConfigRef.current !== config) {
        innerRef.current?.loadSerializedState(JSON.stringify(config));
      }
      prevConfigRef.current = config;
    }, [config]);

    // Register/update data adapters whenever they change.
    React.useEffect(() => {
      if (!dataAdapters) {
        return;
      }
      for (const [sourceId, adapter] of Object.entries(dataAdapters)) {
        innerRef.current?.setDataSourceAdapter(sourceId, adapter);
      }
    }, [dataAdapters]);

    return (
      <Box sx={sx}>
        <Studio
          ref={innerRef}
          initialState={config}
          onStateChange={onStateChange}
          featureFlags={mergedFlags}
          localeText={localeText}
          stackBreakpoint={stackBreakpoint}
          sidebarSide={sidebarSide}
          customWidgets={customWidgets}
          geographies={geographies}
        />
      </Box>
    );
  }),
);
