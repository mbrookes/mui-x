import type { StudioAISkill } from './models/aiTypes';

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

/**
 * Guides the AI when answering data questions using query tools.
 *
 * Trigger phrases: "what is the total X?", "how many Y?", "show me top N by Z",
 * "what are the values of field X?", "average / sum / count of X".
 *
 * This is an `instruction-only` skill — it adds no callable tool. It shapes
 * how the model decides which data tool to invoke and how to present results.
 */
export const dataAnalystSkill: StudioAISkill = {
  name: 'dataAnalyst',
  mode: 'instruction-only',
  promptFragment: `Trigger conditions: user asks a question that requires looking at actual data values —
totals, averages, counts, top-N lists, distributions, comparisons, "how many", "what is the X".

When triggered:
1. If you don't know the data source structure, call describe_data_source first to get the schema and a sample.
2. To understand what values a categorical field contains (e.g. "what statuses exist?"), call get_field_values.
3. For aggregate questions (totals, averages, top-N rankings), call query_data_source with the appropriate aggregations and orderBy.
4. For precise full-table statistics on numeric fields, call compute_field_stats.
5. After getting results with ≥3 data points, call render_chart to visualize them (bar for comparisons, line for trends, pie for composition).
6. Present results as a direct answer — round large numbers, use units, never dump raw JSON.
7. Do NOT call any dashboard-configuration tool (add_widget, update_widget, etc.) unless the user explicitly asks to add or change a widget.
8. If data tools are not available (no "Available data tools" section in the system prompt), say so in one sentence and stop.`,
};

/**
 * Helps users explore the dashboard when they don't know what pages or widgets exist.
 *
 * Trigger phrases: "what's on the X page?", "what pages are there?",
 * "show me page Y", "what does this dashboard have?", "what widgets are available?".
 */
export const pageExplorerSkill: StudioAISkill = {
  name: 'pageExplorer',
  mode: 'instruction-only',
  promptFragment: `Trigger conditions: user asks what pages exist, what's on a specific page, or wants an overview of what the dashboard contains.

When triggered:
1. Call list_pages to get all pages and their widget titles.
2. If the user asks about a specific page's data, call summarise_page with that page's pageId — do NOT call set_active_page just to read it.
3. Answer in plain language: describe each page's purpose based on its widget titles and types.
4. If the user says "go to page X" or "switch to page X", THEN call set_active_page.`,
};
