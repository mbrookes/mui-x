'use client';

export interface StudioDrilldownDrawerProps {
  /** Width of the drilldown drawer in pixels. @default 480 */
  width?: number;
}

/**
 * @deprecated The drilldown feature has been removed. This component renders nothing.
 * It is kept exported to avoid breaking consumers who reference it.
 */
export function StudioDrilldownDrawer(_props: StudioDrilldownDrawerProps) {
  return null;
}
