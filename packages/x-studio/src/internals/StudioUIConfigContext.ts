import * as React from 'react';

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
}

export const StudioUIConfigContext = React.createContext<StudioUIConfig>({
  tableSourceMode: 'explicit',
});
