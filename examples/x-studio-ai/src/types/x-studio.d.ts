declare module '@mui/x-studio' {
  import * as React from 'react';

  export interface StudioAIConfig {
    endpoint: string;
    headers?: Record<string, string>;
    allowedTools?: string[];
  }

  export interface StudioPage {
    id: string;
    title: string;
    widgetRows?: string[][];
    [key: string]: unknown;
  }

  export interface StudioState {
    dashboard: { activePageId?: string; [key: string]: unknown };
    dataSources: Record<
      string,
      { id: string; rows?: Record<string, unknown>[]; [key: string]: unknown }
    >;
    pages: Record<string, StudioPage>;
    widgets: Record<string, unknown>;
    filters: unknown[];
    [key: string]: unknown;
  }

  export interface SerializedStudioState {
    [key: string]: unknown;
  }

  export interface MigrationResult {
    success: boolean;
    state?: SerializedStudioState;
    error?: string;
  }

  export interface StudioLocaleText {
    [key: string]: string | undefined;
  }

  export interface StudioMapGeographyDefinition {
    label: string;
    fieldLabel: string;
    fieldHint?: string;
    normalizer: (value: unknown) => string | null;
    loader: () => Promise<GeoJSON.FeatureCollection>;
  }

  export type StudioFilterNode =
    | {
        type: 'leaf';
        field: string;
        op: string;
        value?: unknown;
        value2?: unknown;
        op2?: string;
        conjunction?: 'and' | 'or';
      }
    | {
        type: 'group';
        logic: 'and' | 'or';
        children: StudioFilterNode[];
      };

  export interface StudioQueryDescriptor {
    filter?: StudioFilterNode;
    groupBy?: string;
    aggregations?: Array<{ alias: string; field: string; fn: string }>;
  }

  export interface StudioQueryResult {
    rows: Record<string, unknown>[];
    totalCount: number;
  }

  export interface StudioDataSourceAdapter {
    getRows(descriptor: StudioQueryDescriptor): Promise<StudioQueryResult>;
  }

  export interface StudioController {
    addPage(title: string): string;
    removePage(pageId: string): void;
    renamePage(pageId: string, title: string): void;
    reorderPages(pageIds: string[]): void;
    setActivePage(pageId: string): void;
    setMode(mode: 'view' | 'edit'): void;
    setDataSourceAdapter(dataSourceId: string, adapter: unknown): void;
    getState(): StudioState;
    serializeState(): SerializedStudioState;
    loadSerializedState(serialized: unknown): MigrationResult;
    subscribe(listener: (state: StudioState) => void): () => void;
  }

  export function createDefaultStudioState(): StudioState;
  export function createStudioController(state: StudioState): StudioController;
  export function serializeState(state: StudioState): SerializedStudioState;
  export function deserializeState(serialized: SerializedStudioState): StudioState;
  export function migrateState(serialized: unknown): MigrationResult;

  export interface BatchingAdapterOptions {
    batchDelayMs?: number;
    fetchFn?: typeof fetch;
  }
  export function createBatchingAdapter(
    endpoint: string,
    options?: BatchingAdapterOptions,
  ): StudioDataSourceAdapter;

  export const ptBRLocaleText: Partial<StudioLocaleText>;

  export const selectDashboard: (state: StudioState) => StudioState['dashboard'];
  export const selectPages: (state: StudioState) => StudioState['pages'];
  export const selectActivePage: (state: StudioState) => StudioPage | null;
  export const selectMode: (state: StudioState) => 'view' | 'edit';

  export function useStudioSelector<T>(selector: (state: StudioState) => T): T;
  export function useStudioController(): StudioController;
  export function useStudioKeyboardShortcuts(): void;

  export interface StudioProviderProps {
    controller: StudioController;
    aiConfig?: StudioAIConfig;
    geographies?: Record<string, StudioMapGeographyDefinition>;
    localeText?: Partial<StudioLocaleText>;
    children?: React.ReactNode;
  }

  export const StudioProvider: React.ComponentType<StudioProviderProps>;
  export const StudioCanvas: React.ComponentType<{ sx?: unknown; slotProps?: unknown }>;
  export const StudioChatPanel: React.ComponentType<{
    aiConfig: StudioAIConfig;
    focusedWidgetId?: string;
    slotProps?: {
      chatBox?: {
        initialMessages?: unknown[];
        onMessagesChange?: (messages: unknown[]) => void;
        initialComposerValue?: string;
        composerValue?: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
  }>;
  export const StudioWordmark: React.ComponentType<{ height?: number }>;
  export const StudioWidgetEditDialog: React.ComponentType<Record<string, never>>;
}
