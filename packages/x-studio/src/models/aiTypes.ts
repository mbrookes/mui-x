// Moved to `@mui/x-studio-schema` (shared AI-protocol + conversation types).
// Server-only AI types (StudioAISkill with `execute`, SkillExecuteResult,
// StudioAIDataConfig, rate-limit/usage types) live in @mui/x-studio-ai-middleware.
// Re-exported here — scoped to just the names that live in the schema package's
// own `aiTypes.ts` module — so existing deep imports (`../models/aiTypes`) keep
// working without surfacing the entire schema package.
export type {
  SerializableSkill,
  StateMutation,
  MutationEnvelope,
  StudioAIFieldStat,
  StudioAILayoutWidget,
  StudioAICrossFilterEdge,
  StudioAIPageLayout,
  StudioAIRecentMutation,
  StudioAIRichContext,
  StudioAIToolName,
  StudioAIChatThread,
  StudioAIState,
} from '@mui/x-studio-schema';
