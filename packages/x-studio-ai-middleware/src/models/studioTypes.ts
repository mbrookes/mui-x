/**
 * The MUI X Studio data model, re-exported from the shared, dependency-free
 * `@mui/x-studio-schema` package.
 *
 * This package used to keep a hand-synced copy of these types (which had already
 * drifted behind `@mui/x-studio`). They now live in one place; this module is a
 * thin re-export so existing imports (`./models/studioTypes`) keep working.
 *
 * `StudioState`, `StudioWidget`, `StudioWidgetConfig`, filters, sources,
 * expressions, `createDefaultStudioState`, and `createDefaultWidget` all come
 * from the schema package.
 */
export * from '@mui/x-studio-schema';

/**
 * Server-side subset of `StudioCustomWidgetDef`.
 *
 * The React `component`, `setupPanel`, and `icon` fields are omitted — the
 * server only needs the serializable metadata to build the AI system prompt.
 * This is intentionally NOT part of the shared schema (the client's full,
 * React-typed `StudioCustomWidgetDef` lives in `@mui/x-studio`); values produced
 * there structurally satisfy this subset at the app boundary.
 */
export interface StudioCustomWidgetDef {
  kind: string;
  label: string;
  description?: string;
  requiresDataSource?: boolean;
  aiInsight?: boolean;
  defaultConfig?: Record<string, unknown>;
}
