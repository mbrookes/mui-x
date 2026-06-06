import type { StudioAISkill } from '../../models';

/**
 * Narrates the current dashboard when the user asks for a walkthrough or overview.
 *
 * Trigger phrases: "walk me through this dashboard", "explain this dashboard",
 * "what does this dashboard show", "give me an overview".
 *
 * This is an `instruction-only` skill — it adds no callable tool. The model
 * reads the `<dashboard_state>` context and composes a plain-text narrative.
 */
export const dashboardNarratorSkill: StudioAISkill = {
  name: 'dashboardNarrator',
  mode: 'instruction-only',
  promptFragment: `Trigger conditions: user asks to "walk me through", "explain", "describe",
or "give an overview of" the dashboard.

When triggered:
- Respond in plain text only. Do not call any tool.
- Give a concise narrative: state the dashboard's apparent purpose, list each widget by title and type, describe what each one shows, and note any filters that are active.
- Use language a business stakeholder would understand — avoid technical field IDs.
- End with one sentence summarising the story the dashboard tells overall.`,
};

/**
 * Surfaces data-driven insights when the user asks what is interesting or notable.
 *
 * Trigger phrases: "what's interesting?", "any insights?", "what should I look at?",
 * "what stands out?", "highlight anything unusual".
 *
 * This is an `instruction-only` skill — it adds no callable tool. The model
 * reasons over the widget configuration in `<dashboard_state>` and proposes insights.
 */
export const insightSuggestorSkill: StudioAISkill = {
  name: 'insightSuggestor',
  mode: 'instruction-only',
  promptFragment: `Trigger conditions: user asks what is interesting, notable, or unusual, or asks for insights.

When triggered:
- Respond in plain text only. Do not call any tool.
- Based solely on the widget types, titles, and field names visible in <dashboard_state>, suggest 2–4 questions or observations the user could investigate (e.g. "The revenue chart may reveal seasonality — consider adding a date filter to zoom in on Q4").
- Be specific to the actual widgets present. Do not invent data values.
- Each suggestion should be one sentence. Use a numbered list.
- End with a brief note about what additional data or widget type could deepen the analysis.`,
};
