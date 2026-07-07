/**
 * MCP prompt + completion handlers for the x-studio server.
 *
 * Registers `prompts/list`, `prompts/get` (the `query_data_source_examples`
 * prompt), and `completion/complete` (URI-template + prompt-argument
 * autocomplete) on the provided `Server`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { StudioStateBox } from './types';

/** Dependencies required to serve the MCP prompt + completion handlers. */
export interface PromptHandlerDeps {
  stateBox: StudioStateBox;
}

/**
 * Register `prompts/list`, `prompts/get`, and `completion/complete` handlers on
 * `server`.
 */
export function registerPromptHandlers(server: Server, deps: PromptHandlerDeps): void {
  const { stateBox } = deps;

  // ── prompts/list + prompts/get ────────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'query_data_source_examples',
        description:
          'Example `query_data_source` invocations for a data source. ' +
          'Pass a sourceId to focus on one source, or omit to see all.',
        arguments: [
          {
            name: 'sourceId',
            description:
              'ID of the data source to show examples for (e.g. "source-orders"). ' +
              'Omit to include all configured sources.',
            required: false,
          },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: promptArgs } = request.params;

    if (name === 'query_data_source_examples') {
      const requestedId = promptArgs?.sourceId;
      const allSources = Object.values(stateBox.current.runtime.dataSources).filter(
        (s) => !s.hidden && s.tableName,
      );

      if (requestedId && !allSources.some((s) => s.id === requestedId)) {
        throw new Error(
          `Unknown sourceId: "${requestedId}". ` +
            `Available: ${allSources.map((s) => s.id).join(', ')}.`,
        );
      }

      const sources = requestedId ? allSources.filter((s) => s.id === requestedId) : allSources;

      const exampleBlocks = sources.map((s) => {
        const numericField = s.fields.find(
          (f) => !f.hidden && f.type === 'number' && !f.capabilities?.includes('categorical'),
        );
        const categoricalField = s.fields.find(
          (f) => !f.hidden && (f.type === 'string' || f.capabilities?.includes('categorical')),
        );

        const countExample = categoricalField
          ? {
              sourceId: s.id,
              columns: [categoricalField.id],
              aggregations: [{ column: categoricalField.id, func: 'count', alias: 'count' }],
              orderBy: [{ column: 'count', direction: 'desc' }],
              limit: 10,
              _desc: `Count of ${s.label} by ${categoricalField.label}`,
            }
          : null;

        const sumExample =
          numericField && categoricalField
            ? {
                sourceId: s.id,
                columns: [categoricalField.id],
                aggregations: [
                  {
                    column: numericField.id,
                    func: numericField.defaultAggregationFn ?? 'sum',
                    alias: numericField.id,
                  },
                ],
                orderBy: [{ column: numericField.id, direction: 'desc' }],
                limit: 10,
                _desc: `${numericField.defaultAggregationFn ?? 'Sum'} of ${numericField.label} by ${categoricalField.label}`,
              }
            : null;

        const queries = [countExample, sumExample].filter(
          (q): q is NonNullable<typeof q> => q !== null,
        );
        const lines = queries.map(({ _desc, ...params }) => {
          return `- ${_desc}\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``;
        });
        return `### ${s.label} (sourceId: "${s.id}")\n${lines.join('\n')}`;
      });

      const subject =
        sources.length === 1
          ? `the **${sources[0].label}** data source`
          : `${sources.length} data source${sources.length !== 1 ? 's' : ''}`;

      const assistantText =
        `I have access to ${subject} and can query ${sources.length === 1 ? 'it' : 'them'} ` +
        `using the \`query_data_source\` tool. Here are some example queries to get started:\n\n` +
        `${exampleBlocks.join('\n\n')}\n\n` +
        `Adapt these by changing \`columns\`, \`aggregations\`, \`filters\`, and \`orderBy\` as needed.`;

      const userText =
        sources.length === 1
          ? `Help me explore the ${sources[0].label} data.`
          : `Help me explore the data.`;

      return {
        description:
          sources.length === 1
            ? `Example queries for the ${sources[0].label} data source`
            : 'Example queries for all configured data sources',
        messages: [
          {
            role: 'assistant' as const,
            content: { type: 'text' as const, text: assistantText },
          },
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: userText },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: "${name}".`);
  });

  // ── completion/complete — URI autocomplete ────────────────────────────────
  // Returns sourceId completions when clients type studio://schema/ or studio://data/.

  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    const { ref, argument } = request.params;

    // Prompt argument autocomplete: sourceId for query_data_source_examples
    if (
      ref.type === 'ref/prompt' &&
      ref.name === 'query_data_source_examples' &&
      argument.name === 'sourceId'
    ) {
      const partial = argument.value ?? '';
      const matches = Object.values(stateBox.current.runtime.dataSources)
        .filter((s) => !s.hidden && s.tableName && s.id.startsWith(partial))
        .map((s) => s.id);
      return { completion: { values: matches, total: matches.length, hasMore: false } };
    }

    // Only handle resource template completions below
    if (ref.type !== 'ref/resource') {
      return { completion: { values: [], total: 0, hasMore: false } };
    }
    // argument.value is the partial string the user has typed so far
    const partial = argument.value ?? '';
    const sourceIds = Object.keys(stateBox.current.runtime.dataSources).filter(
      (id) => !stateBox.current.runtime.dataSources[id].hidden,
    );

    let matches: string[] = [];
    if (ref.uri.startsWith('studio://schema/') || partial.startsWith('studio://schema/')) {
      const fragment = partial.startsWith('studio://schema/')
        ? partial.slice('studio://schema/'.length)
        : partial;
      matches = sourceIds
        .filter((id) => id.startsWith(fragment))
        .map((id) => `studio://schema/${id}`);
    } else if (ref.uri.startsWith('studio://data/') || partial.startsWith('studio://data/')) {
      const fragment = partial.startsWith('studio://data/')
        ? partial.slice('studio://data/'.length)
        : partial;
      matches = sourceIds
        .filter(
          (id) => id.startsWith(fragment) && stateBox.current.runtime.dataSources[id].tableName,
        )
        .map((id) => `studio://data/${id}`);
    }

    return { completion: { values: matches, total: matches.length, hasMore: false } };
  });
}
