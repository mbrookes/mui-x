import * as React from 'react';
import {
  createBatchingAdapter,
  createDefaultStudioState,
  createStudioController,
} from '@mui/x-studio';
import type { StudioController, StudioDataSourceAdapter, StudioState } from '@mui/x-studio';
import { INITIAL_STATE, generateSalesData } from 'x-studio-shared';
import { createDataAdapter } from '../dataAdapter';

const DASHBOARD_STORAGE_PREFIX = 'x-studio-ai-dashboard-';

const generatedSources = generateSalesData({ seed: 42 });
const salesSources = [
  generatedSources.customersSource,
  generatedSources.productsSource,
  generatedSources.ordersSource,
  generatedSources.orderItemsSource,
  generatedSources.shipmentsSource,
  generatedSources.shipmentItemsSource,
] as const;

const mergedDataSources = {
  ...INITIAL_STATE.dataSources,
  ...Object.fromEntries(salesSources.map((source) => [source.id, source])),
} as StudioState['dataSources'];

function buildInitialStudioState(): StudioState {
  const defaultState = createDefaultStudioState();
  const initialState = INITIAL_STATE as Partial<StudioState>;
  const defaultPageId = 'page-1';

  return {
    ...defaultState,
    ...initialState,
    dashboard: {
      ...defaultState.dashboard,
      ...initialState.dashboard,
      activePageId: defaultPageId,
    },
    dataSources: {
      ...defaultState.dataSources,
      ...mergedDataSources,
    },
    pages: {
      [defaultPageId]: { id: defaultPageId, title: 'Dashboard', widgetRows: [] },
    },
    widgets: {},
    filters: [],
  };
}

/**
 * Build the data adapter for each source.
 * When STUDIO_SERVER_URL is set, routes through the dev server's
 * /api/studio-data endpoint using a shared batching adapter.
 * Falls back to the in-memory adapter that uses the generated rows.
 */
function buildDataAdapter(
  _sourceId: string,
  rows: Record<string, unknown>[],
): StudioDataSourceAdapter {
  const serverUrl = import.meta.env.STUDIO_SERVER_URL as string | undefined;
  if (serverUrl) {
    const dataEndpoint = `${serverUrl.replace(/\/$/, '')}/api/studio-data`;
    const serverToken = import.meta.env.STUDIO_SERVER_TOKEN as string | undefined;
    const fetchFn: typeof fetch = serverToken
      ? (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...init?.headers, Authorization: `Bearer ${serverToken}` },
          })
      : globalThis.fetch;
    return createBatchingAdapter(dataEndpoint, { fetchFn });
  }
  return createDataAdapter(rows);
}

function registerAdapters(controller: StudioController) {
  Object.values(mergedDataSources).forEach((source) => {
    if (source.rows && source.rows.length > 0) {
      controller.setDataSourceAdapter(
        source.id,
        buildDataAdapter(source.id, source.rows as Record<string, unknown>[]),
      );
    }
  });
}

export function useChatControllers() {
  const controllersRef = React.useRef<Map<string, StudioController>>(new Map());

  const getOrCreateController = React.useCallback((chatId: string): StudioController => {
    const existing = controllersRef.current.get(chatId);
    if (existing) {
      return existing;
    }

    const controller = createStudioController(buildInitialStudioState());
    registerAdapters(controller);

    if (chatId !== '__home__') {
      const saved = localStorage.getItem(`${DASHBOARD_STORAGE_PREFIX}${chatId}`);
      if (saved) {
        try {
          controller.loadSerializedState(JSON.parse(saved));
        } catch {
          // Ignore malformed persisted state and fall back to the initial dashboard.
        }
      }
    }

    controllersRef.current.set(chatId, controller);
    return controller;
  }, []);

  const saveController = React.useCallback((chatId: string) => {
    if (chatId === '__home__') {
      return;
    }

    const controller = controllersRef.current.get(chatId);
    if (controller) {
      localStorage.setItem(
        `${DASHBOARD_STORAGE_PREFIX}${chatId}`,
        JSON.stringify(controller.serializeState()),
      );
    }
  }, []);

  return { getOrCreateController, saveController, controllersRef };
}
