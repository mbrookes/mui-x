'use client';
import * as React from 'react';

import type { StudioState, StudioFeatureFlags, StudioCustomWidgetDef } from '../models';
import type { StudioController } from '../store';
import {
  StudioUIConfigContext,
  useStudioFeatures,
  useStudioUIConfig,
  useStudioLocaleText,
  useStudioGeographies,
  useCustomWidgetMap,
  DEFAULT_STUDIO_LOCALE_TEXT,
} from '../internals/StudioUIConfigContext';
import type { StudioLocaleText } from '../internals/StudioUIConfigContext';
import type { StudioAIConfig } from '../components/StudioChatPanel/studioBackendAdapter';
import type { StudioMapGeographyDefinition } from '../components/widgets/StudioMapWidget/geographyLoaders';

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
  /**
   * Locale text overrides. Merge any subset of tokens over the English defaults.
   * Use a pre-built translation object (e.g. `ptBRLocaleText`) or a partial
   * override to customise individual strings.
   */
  localeText?: Partial<StudioLocaleText>;
  /**
   * AI/LLM configuration. When provided and `featureFlags.aiChat` is not `false`,
   * the "Describe a widget" prompt appears in the compose drawer and the AI assistant panel is available.
   */
  aiConfig?: StudioAIConfig | null;
  /**
   * Consumer-defined custom widget kinds shown alongside the built-in widgets in the widget picker.
   * Each entry registers a `kind` identifier, a render `component`, and optional compose-drawer
   * `setupPanel`. See {@link StudioCustomWidgetDef} for the full registration shape.
   */
  customWidgets?: StudioCustomWidgetDef[];
  /**
   * Additional map geography definitions to register alongside the built-in `'world'`,
   * `'usa'`, and `'europe'` geographies.
   *
   * Each entry defines how to load the topology, how to normalise raw data values to
   * feature IDs, and how the geography appears in the Map Setup panel.
   */
  geographies?: Record<string, StudioMapGeographyDefinition>;
}

export function StudioProvider(props: StudioProviderProps) {
  const {
    children,
    controller,
    tableSourceMode = 'explicit',
    featureFlags = {},
    localeText,
    aiConfig,
    customWidgets,
    geographies,
  } = props;

  const uiConfig = React.useMemo(
    () => ({
      tableSourceMode,
      featureFlags,
      localeText: localeText
        ? { ...DEFAULT_STUDIO_LOCALE_TEXT, ...localeText }
        : DEFAULT_STUDIO_LOCALE_TEXT,
      aiConfig: aiConfig ?? null,
      customWidgets,
      geographies,
    }),
    [tableSourceMode, featureFlags, localeText, aiConfig, customWidgets, geographies],
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

export {
  useStudioFeatures,
  useStudioUIConfig,
  useStudioLocaleText,
  useStudioGeographies,
  useCustomWidgetMap,
};
