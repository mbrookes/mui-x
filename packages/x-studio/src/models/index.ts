// The shared data model now lives in the dependency-free `@mui/x-studio-schema`
// package so `@mui/x-studio` and `@mui/x-studio-ai-middleware` can no longer
// drift. These are thin re-exports; edit the schema package to change a type.
export * from '@mui/x-studio-schema';
// React-dependent custom-widget registration types stay in this package.
export * from './customWidgetTypes';
// UI feature-flag prop types (component props, not persisted/AI-protocol state).
export * from './featureFlags';
export type { StudioAIConfig } from './aiConfig';
