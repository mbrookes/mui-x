/**
 * `createDefaultWidget` now lives in the shared, dependency-free
 * `@mui/x-studio-schema` package so UI-created and AI-created widgets share the
 * exact same default config. Re-exported here to keep the existing internal
 * import path (`../internals/widgetFactory`) working.
 */
export { createDefaultWidget } from '@mui/x-studio-schema';
