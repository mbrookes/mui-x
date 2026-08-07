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
 * The widget-kind metadata this package needs to describe available kinds in the system prompt.
 *
 * Was a hand-maintained subset of `@mui/x-studio`'s React-typed `StudioCustomWidgetDef`, whose
 * own doc noted that the client's values "structurally satisfy this subset at the app boundary" —
 * two declarations of one contract, kept in agreement by structural typing and a comment. It is
 * now the shared `StudioWidgetKindDescriptor`, which the client's def extends, so the two cannot
 * disagree about which fields a kind carries.
 */
export type { StudioWidgetKindDescriptor as StudioCustomWidgetDef } from '@mui/x-studio-schema';
