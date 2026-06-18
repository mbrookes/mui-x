import type * as React from 'react';
import type { FunnelSectionProps } from './FunnelSection';
import { type FunnelSectionLabelProps } from './FunnelSectionLabel';
import { type FunnelLabelLineProps } from './FunnelLabelLine';
import type {
  FunnelSectionPropsOverrides,
  FunnelSectionLabelPropsOverrides,
  FunnelLabelLinePropsOverrides,
} from '../models/chartsSlotsComponentsPropsPro';

export interface FunnelPlotSlots {
  /**
   * Custom component for funnel section.
   * @default FunnelSection
   */
  funnelSection?: React.ElementType<FunnelSectionProps & FunnelSectionPropsOverrides>;
  /**
   * Custom component for funnel section label.
   * @default FunnelSectionLabel
   */
  funnelSectionLabel?: React.ElementType<
    FunnelSectionLabelProps & FunnelSectionLabelPropsOverrides
  >;
  /**
   * Custom component for the connector line between a funnel section and its outside label.
   * @default FunnelLabelLine
   */
  funnelLabelLine?: React.ElementType<FunnelLabelLineProps & FunnelLabelLinePropsOverrides>;
}

export interface FunnelPlotSlotProps {
  funnelSection?: Partial<FunnelSectionProps> & FunnelSectionPropsOverrides;
  funnelSectionLabel?: Partial<FunnelSectionLabelProps> & FunnelSectionLabelPropsOverrides;
  funnelLabelLine?: Partial<FunnelLabelLineProps> & FunnelLabelLinePropsOverrides;
}

export interface FunnelPlotSlotExtension {
  /**
   * Overridable component slots.
   * @default {}
   */
  slots?: FunnelPlotSlots;
  /**
   * The props used for each component slot.
   * @default {}
   */
  slotProps?: FunnelPlotSlotProps;
}
