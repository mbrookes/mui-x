/**
 * Declarative registry of FACTS about every built-in x-studio AI tool.
 *
 * Before this file, the facts about one tool — its display title, whether it's
 * destructive, whether MCP overrides that classification, its MCP read-only /
 * idempotent / open-world hints, whether it's withheld in private mode, and
 * whether MCP supports it at all — were scattered across ~7 hand-maintained
 * artifacts that nothing type-checked against each other:
 *  - `STUDIO_AI_TOOLS` / `STUDIO_AI_TOOL_NAMES` / `DESTRUCTIVE_TOOLS` in
 *    `@mui/x-studio-ai-middleware`'s `studioAITools.ts`
 *  - a hand-written `StudioAIToolName` union here, kept in sync via a
 *    bidirectional type assert
 *  - `TOOL_TITLES` / `TOOL_ANNOTATIONS` in `mcp/toolMetadata.ts`
 *  - the `executeToolOnState.ts` switch statement
 *  - `PRIVATE_MODE_EXCLUDED_TOOLS` (inside `runAgenticLoop` in `agenticLoop.ts`)
 *  - `MCP_UNSUPPORTED_TOOLS` (in `mcp.ts`)
 *
 * This registry is the single source of truth for those FACTS (not
 * implementations, not full JSON-schema parameter definitions — just the
 * classification/availability facts above). It lives here (in the
 * dependency-free schema package, not the server package) so the client can
 * import `StudioAIToolName` — and any of these facts — without depending on
 * `@mui/x-studio-ai-middleware`. Every one of the ~7 artifacts above is now
 * DERIVED from `STUDIO_AI_TOOL_REGISTRY`, so two of them can no longer
 * disagree about one tool.
 */

export interface StudioAIToolFacts {
  /** Human-readable display title (shown in Claude Desktop's permission editor). */
  title: string;
  /**
   * Whether the tool requires explicit user confirmation before executing on
   * the chat transport (drives `agenticLoop.ts`'s approval gate) and is the
   * MCP `destructiveHint` default (see `mcpDestructiveOverride` below).
   */
  destructive: boolean;
  /**
   * MCP-only override: destructive on MCP even though it isn't
   * chat-approval-gated (e.g. `remove_page_filter`/`remove_widget_filter` —
   * MCP clients have no separate confirmation step and these tools
   * permanently delete an entity).
   */
  mcpDestructiveOverride?: boolean;
  /** MCP `readOnlyHint` — the tool never modifies state. */
  readOnly?: boolean;
  /** MCP `idempotentHint` — applying the same args twice has no additional effect. */
  idempotent?: boolean;
  /** MCP `openWorldHint` — the tool may interact with an "open world" (e.g. arbitrary queries). */
  openWorld?: boolean;
  /**
   * Excluded from the advertised tool list under `privateMode` — the tool's
   * output would round-trip real dashboard/business data back to the LLM
   * provider, defeating the point of private mode.
   */
  privateModeExcluded?: boolean;
  /**
   * False for tools that exist in `STUDIO_AI_TOOLS` but are never registered
   * as an MCP tool because they have no functional MCP handler.
   */
  mcpSupported: boolean;
}

export const STUDIO_AI_TOOL_REGISTRY = {
  get_dashboard_state: {
    title: 'Get dashboard state',
    destructive: false,
    readOnly: true,
    idempotent: true,
    openWorld: false,
    privateModeExcluded: true,
    mcpSupported: true,
  },
  list_pages: {
    title: 'List pages',
    destructive: false,
    readOnly: true,
    idempotent: true,
    openWorld: false,
    privateModeExcluded: true,
    mcpSupported: true,
  },
  add_page: {
    title: 'Add page',
    destructive: false,
    openWorld: false,
    mcpSupported: true,
  },
  set_dashboard_title: {
    title: 'Set dashboard title',
    destructive: false,
    idempotent: true,
    openWorld: false,
    mcpSupported: true,
  },
  add_widget: {
    title: 'Add widget',
    destructive: false,
    openWorld: false,
    mcpSupported: true,
  },
  update_widget: {
    title: 'Update widget',
    destructive: false,
    idempotent: true,
    openWorld: false,
    mcpSupported: true,
  },
  remove_widget: {
    title: 'Remove widget',
    destructive: true,
    openWorld: false,
    mcpSupported: true,
  },
  set_widget_layout: {
    title: 'Set widget layout',
    destructive: false,
    idempotent: true,
    openWorld: false,
    mcpSupported: true,
  },
  set_widget_width: {
    title: 'Set widget width',
    destructive: false,
    idempotent: true,
    openWorld: false,
    mcpSupported: true,
  },
  rename_page: {
    title: 'Rename page',
    destructive: false,
    idempotent: true,
    openWorld: false,
    mcpSupported: true,
  },
  remove_page: {
    title: 'Remove page',
    destructive: true,
    openWorld: false,
    mcpSupported: true,
  },
  set_active_page: {
    title: 'Switch page',
    destructive: false,
    idempotent: true,
    openWorld: false,
    mcpSupported: true,
  },
  add_page_filter: {
    title: 'Add page filter',
    destructive: false,
    openWorld: false,
    mcpSupported: true,
  },
  remove_page_filter: {
    title: 'Remove page filter',
    destructive: false,
    mcpDestructiveOverride: true,
    openWorld: false,
    mcpSupported: true,
  },
  add_widget_filter: {
    title: 'Add widget filter',
    destructive: false,
    openWorld: false,
    mcpSupported: true,
  },
  remove_widget_filter: {
    title: 'Remove widget filter',
    destructive: false,
    mcpDestructiveOverride: true,
    openWorld: false,
    mcpSupported: true,
  },
  summarise_page: {
    title: 'Summarise page',
    destructive: false,
    readOnly: true,
    idempotent: true,
    openWorld: false,
    privateModeExcluded: true,
    mcpSupported: true,
  },
  apply_bulk_update: {
    title: 'Apply bulk update',
    destructive: true,
    openWorld: false,
    mcpSupported: true,
  },
  rename_thread: {
    title: 'Rename thread',
    destructive: false,
    idempotent: true,
    openWorld: false,
    mcpSupported: true,
  },
  query_data_source: {
    title: 'Query data source',
    destructive: false,
    readOnly: true,
    idempotent: true,
    openWorld: true,
    privateModeExcluded: true,
    mcpSupported: true,
  },
  set_widget_forecast: {
    title: 'Set widget forecast',
    destructive: false,
    idempotent: true,
    openWorld: false,
    mcpSupported: true,
  },
} as const satisfies Record<string, StudioAIToolFacts>;

export type StudioAIToolName = keyof typeof STUDIO_AI_TOOL_REGISTRY;
