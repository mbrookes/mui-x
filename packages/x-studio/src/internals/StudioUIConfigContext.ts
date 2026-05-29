import * as React from 'react';
import type { StudioFeatureFlags } from '../models/studio';

export interface StudioUIConfig {
  /**
   * Controls how the table widget's data source is determined.
   * - `'explicit'` (default): a data source picker is shown at the top of the
   *   table setup panel — the user must choose a source before adding columns.
   * - `'implicit'`: no source picker is shown. The source is inferred from the
   *   first column the user adds (Tableau / Power BI style). Removing all
   *   columns resets the source so a different one can be chosen.
   */
  tableSourceMode: 'explicit' | 'implicit';
  /** Runtime feature flags controlling which UI features are available. */
  featureFlags: StudioFeatureFlags;
}

export const StudioUIConfigContext = React.createContext<StudioUIConfig>({
  tableSourceMode: 'explicit',
  featureFlags: {},
});

/** Returns the resolved UI config including feature flags. */
export function useStudioUIConfig(): StudioUIConfig {
  return React.useContext(StudioUIConfigContext);
}

/** Returns the active feature flags. All flags default to `true` when not explicitly set. */
export function useStudioFeatures(): Required<StudioFeatureFlags> {
  const { featureFlags } = useStudioUIConfig();
  return {
    compose: featureFlags.compose ?? true,
    filters: featureFlags.filters ?? true,
    savedFilterViews: featureFlags.savedFilterViews ?? true,
    dataManagement: featureFlags.dataManagement ?? true,
    aiChat: featureFlags.aiChat ?? true,
  };
}
