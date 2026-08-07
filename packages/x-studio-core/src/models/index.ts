// The shared data model lives in the dependency-free `@mui/x-studio-schema` package so every
// consumer — this engine, the React binding, and both middleware packages — reads one definition.
// These are thin re-exports; edit the schema package to change a type.
//
// React-dependent types (`customWidgetTypes`, `featureFlags`) and host UI config (`aiConfig`)
// deliberately do NOT live here: this package must be importable without React, and a binding is
// the only thing that can name a component type.
export * from '@mui/x-studio-schema';
