'use client';
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
   * This is the full `StudioState` returned by `Studio` ref's `getState()`.
   *
   * Note: this is NOT the output of `serializeState()`. `serializeState()` returns the
   * persisted, doc-only `SerializedStudioState` shape (no `runtime`/`session` partitions),
   * which does not satisfy this prop's `StudioState` type — passing it would drop the data
   * sources and mis-shape the config.
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
   * Each adapter is an object with a `getRows` method (see `StudioDataSourceAdapter`).
   * When a source does not have an adapter, it falls back to the static `rows` data baked
   * into the `config` (useful for small reference tables or demo data).
   *
   * @example
   * ```tsx
   * const adapters = {
   *   orders: {
   *     async getRows(descriptor) {
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
   * BCP-47 language tag used by every `Intl` formatter in the dashboard — numbers,
   * currencies, dates, month names, and map region names. Pair it with `localeText`, or the
   * formatters resolve to the browser's locale while the labels use the chosen bundle.
   * Defaults to the runtime/browser locale.
   */
  locale?: string;
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
export const StudioDashboard = React.memo(function StudioDashboard({
  ref,
  config,
  dataAdapters,
  onStateChange,
  featureFlags,
  localeText,
  locale,
  stackBreakpoint,
  sidebarSide,
  customWidgets,
  geographies,
  sx,
}: StudioDashboardProps & { ref?: React.Ref<StudioHandle> }) {
  // Merge caller-supplied flags on top of view-only defaults

  const mergedFlags = React.useMemo<StudioFeatureFlags>(
    () => ({ ...DEFAULT_EMBED_FLAGS, ...featureFlags }),
    [featureFlags],
  );

  const innerRef = React.useRef<StudioHandle>(null);

  // Expose the underlying handle to the caller's ref
  React.useImperativeHandle(ref, () => innerRef.current!, []);

  // Latest `dataAdapters` map, read by the config-swap effect (1.1) so it can re-apply
  // adapters after a reload without taking `dataAdapters` as an effect dependency (hosts
  // are steered toward a referentially STABLE map, so a config swap that introduces or
  // re-adds a source would otherwise never re-register that source's adapter). Kept in a
  // ref rather than a dep so the config-swap effect's deps can stay `[config]`.
  const dataAdaptersRef = React.useRef(dataAdapters);
  dataAdaptersRef.current = dataAdapters;

  // Load new config whenever the prop reference changes.
  // We compare by reference (not deep equality) to avoid unnecessary reloads.
  const prevConfigRef = React.useRef<StudioState | null>(null);
  React.useEffect(() => {
    if (prevConfigRef.current !== null && prevConfigRef.current !== config) {
      // `loadSerializedState` expects the (de)serialized DOC shape (`config.doc` — dashboard/
      // pages/widgets/filters/…), not a JSON string and not the full lifetime-partitioned
      // `StudioState` — it runs the value through `migrateState`/`validateStateStructure`,
      // which only checks `typeof state === 'object'`, so passing `config` itself (rather
      // than `config.doc`) would "succeed" the check but leave every doc field undefined.
      // Passing the object directly (rather than `JSON.stringify(config.doc)`) is what
      // actually lets migration succeed.
      const result = innerRef.current?.loadSerializedState(config.doc);
      if (result && !result.success) {
        console.error(
          '[StudioDashboard] Failed to load the new `config` prop — the dashboard was left ' +
            'showing its previous state. Errors:',
          result.errors,
        );
      } else {
        // `loadSerializedState` re-injects the *previous* controller state's `dataSources`
        // (they are never part of the persisted/serialized shape), so the new config's own
        // data sources must be explicitly re-applied or they'd silently disappear.
        for (const dataSource of Object.values(config.runtime.dataSources)) {
          innerRef.current?.upsertDataSource(dataSource);
        }
        // Prune stale sources (2.1): `loadSerializedState` preserved the ENTIRE previous
        // `runtime.dataSources`, so a source the new config dropped would otherwise survive
        // forever (and e.g. keep `StudioDateRangeBar`'s coverage-expansion effect minting a
        // `dashboard-date-range` filter for it). Remove any runtime source whose id isn't in
        // the new config's `runtime.dataSources`.
        const nextSourceIds = new Set(Object.keys(config.runtime.dataSources));
        const currentSources = innerRef.current?.getState().runtime.dataSources;
        if (currentSources) {
          for (const sourceId of Object.keys(currentSources)) {
            if (!nextSourceIds.has(sourceId)) {
              innerRef.current?.removeDataSource(sourceId);
            }
          }
        }
        // Re-apply adapters (1.1): the `dataAdapters` registration effect only runs on
        // `[dataAdapters]` identity change, so a config swap that INTRODUCES or RE-ADDS a
        // source (while the host keeps a referentially stable `dataAdapters` map) would
        // leave that source adapter-less — `setDataSourceAdapter` no-ops when the source
        // doesn't exist yet, so the mount-time registration never reached it, and the
        // adapters effect never re-fires. Re-apply the current adapters here now that the
        // new config's sources exist. `setDataSourceAdapter`'s same-reference guard makes
        // re-applying an already-registered adapter a clean no-op, so this is idempotent.
        const currentAdapters = dataAdaptersRef.current;
        if (currentAdapters) {
          for (const [sourceId, adapter] of Object.entries(currentAdapters)) {
            innerRef.current?.setDataSourceAdapter(sourceId, adapter);
          }
        }
      }
    }
    prevConfigRef.current = config;
  }, [config]);

  // Register/update data adapters whenever they change, AND unregister any the host dropped.
  // Tracks the set of source ids registered on the previous run so a key removed from
  // `dataAdapters` gets its adapter cleared (T3.4). The effect previously iterated only the NEW
  // map, so a removed key kept its previously-registered adapter forever — its last fetched rows
  // would then keep shadowing freshly-resolved in-memory rows (this is what makes finding 2.2
  // reachable, addressed together here).
  const prevAdapterSourceIdsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const nextIds = new Set(dataAdapters ? Object.keys(dataAdapters) : []);
    if (dataAdapters) {
      for (const [sourceId, adapter] of Object.entries(dataAdapters)) {
        innerRef.current?.setDataSourceAdapter(sourceId, adapter);
      }
    }
    // Clear adapters for sources present last run but absent now. `setDataSourceAdapter(sid,
    // undefined)` is a clean no-op when the source doesn't exist, so this is always safe.
    for (const sourceId of prevAdapterSourceIdsRef.current) {
      if (!nextIds.has(sourceId)) {
        innerRef.current?.setDataSourceAdapter(sourceId, undefined);
      }
    }
    prevAdapterSourceIdsRef.current = nextIds;
  }, [dataAdapters]);

  return (
    <Box sx={sx}>
      <Studio
        ref={innerRef}
        initialState={config}
        onStateChange={onStateChange}
        featureFlags={mergedFlags}
        localeText={localeText}
        locale={locale}
        stackBreakpoint={stackBreakpoint}
        sidebarSide={sidebarSide}
        customWidgets={customWidgets}
        geographies={geographies}
      />
    </Box>
  );
});
