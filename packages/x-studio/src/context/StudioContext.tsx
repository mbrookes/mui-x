'use client';
import * as React from 'react';

import type { StudioState, StudioFeatureFlags } from '../models';
import type { StudioController } from '../store';
import {
  StudioUIConfigContext,
  useStudioFeatures,
  useStudioUIConfig,
} from '../internals/StudioUIConfigContext';

/** Ref to the canvas scroll container, used to scroll to bottom after adding a widget. */
export const CanvasScrollContext =
  React.createContext<React.RefObject<HTMLDivElement | null> | null>(null);

const StudioContext = React.createContext<StudioController | null>(null);

export interface StudioProviderProps {
  controller: StudioController;
  children: React.ReactNode;
  /**
   * Controls how the table widget's data source is determined.
   * @default 'explicit'
   */
  tableSourceMode?: 'explicit' | 'implicit';
  /**
   * Runtime feature flags controlling which UI features are available to users.
   * All flags default to `true` when not specified.
   */
  featureFlags?: StudioFeatureFlags;
}

export function StudioProvider(props: StudioProviderProps) {
  const { children, controller, tableSourceMode = 'explicit', featureFlags = {} } = props;

  const uiConfig = React.useMemo(
    () => ({ tableSourceMode, featureFlags }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tableSourceMode, JSON.stringify(featureFlags)],
  );

  return (
    <StudioContext.Provider value={controller}>
      <StudioUIConfigContext.Provider value={uiConfig}>{children}</StudioUIConfigContext.Provider>
    </StudioContext.Provider>
  );
}

export function useStudioController() {
  const controller = React.use(StudioContext);

  if (controller == null) {
    throw new Error('useStudioController must be used within a StudioProvider.');
  }

  return controller;
}

export function useStudioState() {
  const controller = useStudioController();
  return controller.store.use((state: StudioState) => state);
}

export function useStudioSelector<Value>(selector: (state: StudioState) => Value): Value {
  const controller = useStudioController();
  return controller.store.use(selector) as Value;
}

export { useStudioFeatures, useStudioUIConfig };
