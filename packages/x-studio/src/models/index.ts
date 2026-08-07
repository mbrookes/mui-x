// The React binding's model surface: everything the framework-agnostic engine defines, plus the
// types only a binding can name.
//
// `@mui/x-studio-core/models` re-exports `@mui/x-studio-schema` — the shared, persisted data
// model. Added here are the three things that need React in their type: custom-widget
// registration, UI feature flags, and the host's AI config.
export * from '@mui/x-studio-core/models';
export * from './customWidgetTypes';
export * from './featureFlags';
export type { StudioAIConfig } from './aiConfig';
