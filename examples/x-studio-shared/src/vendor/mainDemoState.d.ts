/**
 * Vendor "main demo" fixture shape — NOT a `StudioState` (flat or nested). It is a
 * proprietary page-array format from an external design tool, consumed only by
 * `officeSuppliesDashboard.ts` (which is `@ts-nocheck`) and converted there into a
 * real x-studio `StudioDoc` via `createXStudioOfficeSuppliesState`.
 */
export interface MainDemoStatePage {
  id: string;
  widgets: Record<string, unknown>;
  widgetLayout: Record<string, unknown>;
  filter?: unknown;
  [key: string]: unknown;
}

export interface MainDemoState {
  pages: MainDemoStatePage[];
  selectedPageId: string;
}

export declare const mainDemoState: MainDemoState;
export declare const executivePage: unknown;
export declare const fulfilmentPage: unknown;
export declare const returnsPage: unknown;
export declare const salesPerformancePage: unknown;
