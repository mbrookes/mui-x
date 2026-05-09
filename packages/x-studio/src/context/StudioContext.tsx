'use client';
import * as React from 'react';

import type { StudioState } from '../models';
import type { StudioController } from '../store';

/** Ref to the canvas scroll container, used to scroll to bottom after adding a widget. */
export const CanvasScrollContext =
  React.createContext<React.RefObject<HTMLDivElement | null> | null>(null);

const StudioContext = React.createContext<StudioController | null>(null);

export interface StudioProviderProps {
  controller: StudioController;
  children: React.ReactNode;
}

export function StudioProvider(props: StudioProviderProps) {
  const { children, controller } = props;

  return <StudioContext.Provider value={controller}>{children}</StudioContext.Provider>;
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
