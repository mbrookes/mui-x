// Moved to `@mui/x-studio-schema` (shared AI-protocol + conversation types).
// Server-only AI types (StudioAISkill with `execute`, SkillExecuteResult,
// StudioDataResolver, rate-limit/usage types) live in @mui/x-studio-ai-middleware.
// Re-exported here so existing deep imports (`../models/aiTypes`) keep working.
export * from '@mui/x-studio-schema';
