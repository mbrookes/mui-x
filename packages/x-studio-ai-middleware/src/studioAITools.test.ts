import { describe, expect, it } from 'vitest';
import { STUDIO_AI_TOOLS, STUDIO_AI_TOOL_NAMES } from './studioAITools';
import type { McpExtraToolName } from './mcp/types';

/**
 * Tool names that exist on the MCP transport ONLY — they are not members of
 * `STUDIO_AI_TOOLS`, so on the chat transport they can never be advertised at all.
 * Naming one in a shared tool description is therefore wrong by construction, not
 * merely wrong for some sessions.
 *
 * Duplicated as a value here (the production side is a type union) and pinned by the
 * `satisfies` below, so adding a member there without adding it here is a compile error.
 */
const MCP_EXTRA_TOOL_NAMES = [
  'describe_data_source',
  'get_field_values',
  'compute_field_stats',
  'render_chart',
  'get_recent_changes',
] satisfies McpExtraToolName[];

const ALL_TOOL_NAMES: string[] = [...STUDIO_AI_TOOL_NAMES, ...MCP_EXTRA_TOOL_NAMES];

/**
 * Every `description` string reachable in a tool definition, paired with a path so a
 * failure names the exact site. Walks nested `parameters`/`properties`/`items`, because
 * half the cross-references that had to be removed lived on a nested parameter
 * (`summarise_page.pageId`, `query_data_source.sourceId`) rather than on the tool.
 */
function collectDescriptions(node: unknown, path: string): Array<[path: string, text: string]> {
  if (Array.isArray(node)) {
    return node.flatMap((entry, i) => collectDescriptions(entry, `${path}[${i}]`));
  }
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    key === 'description' && typeof value === 'string'
      ? [[`${path}.${key}`, value] as [string, string]]
      : collectDescriptions(value, `${path}.${key}`),
  );
}

describe('STUDIO_AI_TOOLS: descriptions never name a tool (invariant 17)', () => {
  const descriptions = collectDescriptions(STUDIO_AI_TOOLS, 'STUDIO_AI_TOOLS');

  it('collects the nested parameter descriptions too, not just the tool-level ones', () => {
    // Guards the guard: a walker that silently stopped at `function.description` would
    // make every assertion below vacuously pass for nested parameters.
    expect(descriptions.length).toBeGreaterThan(STUDIO_AI_TOOLS.length);
    const summarise = STUDIO_AI_TOOLS.find((t) => t.function.name === 'summarise_page')!;
    expect(collectDescriptions(summarise, 'summarise_page').map(([path]) => path)).toContain(
      'summarise_page.function.parameters.properties.pageId.description',
    );
  });

  // Table-driven over the tool-name universe rather than one `it` per known offender:
  // a tool added later is covered automatically, which is the whole point — the
  // previous "no cross-references" pass was true by vigilance and drifted back.
  it.each(ALL_TOOL_NAMES)('no description names `%s`', (toolName) => {
    // Word boundaries so `add_page` does not match inside `add_page_filter`.
    const mention = new RegExp(`(^|[^a-zA-Z0-9_])${toolName}([^a-zA-Z0-9_]|$)`);
    const offenders = descriptions
      .filter(([, text]) => mention.test(text))
      .map(([path, text]) => `${path}: ${text}`);
    expect(offenders).toEqual([]);
  });

  /**
   * Finding H6 — `summarise_page`'s own schema used to advise "otherwise call
   * `set_active_page` first". Following it (`set_active_page(pageB)` then
   * `summarise_page()` with `pageId` OMITTED) slips past the executor's guard, which
   * only fires when `args.pageId` is present, and returns page A's snapshot for the
   * model to narrate as page B. The implementation's error text and ARCHITECTURE.md
   * both say the opposite — omit `pageId`, and ask the USER to open the other page.
   */
  it('advertises omitting pageId — never activating another page — as the recovery', () => {
    const summarise = STUDIO_AI_TOOLS.find((t) => t.function.name === 'summarise_page')!;
    const texts = collectDescriptions(summarise, 'summarise_page').map(([, text]) => text);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect(text).not.toMatch(/set_active_page/);
      expect(text).not.toMatch(/switch/i);
    }
    // The contract the executor actually enforces: omitting is always accepted, and a
    // rejected non-active pageId is not retryable within the turn.
    expect(texts.join('\n')).toMatch(/[Oo]mit/);
    expect(texts.join('\n')).toContain('always accepted');
    expect(texts.join('\n')).toContain('ask the user to open that page');
  });
});
