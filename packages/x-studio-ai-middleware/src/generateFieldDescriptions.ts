/**
 * AI-assisted field description generator.
 *
 * `generateFieldDescriptions` sends field metadata + sampled values to an LLM
 * and returns suggested `aiDescription` strings for each field.
 *
 * This is a batch call: all fields for a data source are described in one
 * LLM request to minimise latency and token overhead.
 *
 * Server-side only — never import from the client (contains LLM credentials).
 */
import type { GenerateInsightOptions } from './handleGenerateInsight';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Metadata about a single field in a data source.
 */
export interface FieldDescriptionInput {
  /** Internal field identifier (e.g. `'order_total'`) */
  id: string;
  /** Human-readable label already provided by the developer (e.g. `'Order Total'`) */
  label: string;
  /** Field data type */
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  /**
   * A small sample of distinct values from this field.
   * Helps the model understand the domain (e.g. `['USD', 'EUR', 'GBP']`).
   * Keep to 10 values or fewer.
   */
  sampleValues?: (string | number | boolean | null)[];
}

/**
 * Result returned by `generateFieldDescriptions` for one field.
 */
export interface FieldDescriptionResult {
  /** The field ID the description corresponds to. */
  id: string;
  /**
   * Suggested `aiDescription` string (1–2 sentences, plain English).
   * Suitable for direct assignment to `StudioDataField.aiDescription`.
   */
  aiDescription: string;
}

// ── Implementation ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a data dictionary assistant helping developers describe fields in a business data source. ' +
  'You will receive a list of fields with their ID, label, type, and sample values. ' +
  'For each field, write a concise 1–2 sentence aiDescription in plain English that explains: ' +
  '(1) what the field represents, and (2) how it is best used in dashboards (e.g. as a KPI value, ' +
  'chart axis, filter, group-by dimension). ' +
  'Be specific about the business meaning when the sample values make it clear. ' +
  'Respond ONLY with a JSON array: [{"id":"...","aiDescription":"..."}, ...]';

/**
 * Generate AI-assisted descriptions for a batch of data source fields.
 *
 * @param sourceLabel  Human-readable name of the data source (e.g. `'Orders'`).
 * @param fields       Fields to describe.
 * @param options      LLM connection options.
 * @returns            Array of `{ id, aiDescription }` objects, one per input field.
 *
 * @example
 * ```ts
 * const descriptions = await generateFieldDescriptions('Orders', [
 *   { id: 'order_total', label: 'Order Total', type: 'number',
 *     sampleValues: [12.5, 200, 4500] },
 *   { id: 'customer_country', label: 'Customer Country', type: 'string',
 *     sampleValues: ['USA', 'Germany', 'France'] },
 * ], { endpoint: process.env.OPENAI_ENDPOINT, apiKey: process.env.OPENAI_API_KEY });
 *
 * // Merge back into your field definitions:
 * const enrichedFields = fields.map(f => ({
 *   ...f,
 *   aiDescription: descriptions.find(d => d.id === f.id)?.aiDescription,
 * }));
 * ```
 */
export async function generateFieldDescriptions(
  sourceLabel: string,
  fields: FieldDescriptionInput[],
  options: GenerateInsightOptions,
): Promise<FieldDescriptionResult[]> {
  if (fields.length === 0) {
    return [];
  }

  const { endpoint, apiKey, model = 'gpt-4o', headers: extraHeaders } = options;

  const fieldList = fields
    .map((f) => {
      const sample =
        f.sampleValues && f.sampleValues.length > 0
          ? ` Sample values: ${f.sampleValues.slice(0, 10).join(', ')}.`
          : '';
      return `id: "${f.id}", label: "${f.label}", type: ${f.type}.${sample}`;
    })
    .join('\n');

  const userContent =
    `Data source: "${sourceLabel}"\n\nFields to describe:\n${fieldList}\n\n` +
    'Return a JSON array with one entry per field.';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      max_tokens: Math.min(200 * fields.length, 4096),
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Field description generation failed: ${response.status} ${errText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = data.choices[0]?.message?.content?.trim() ?? '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Field description: LLM returned unparseable JSON: ${raw.slice(0, 200)}`);
  }

  // Some models (especially with response_format: json_object) wrap the array in
  // an object, e.g. `{ "fields": [...] }`. Unwrap the first array-valued property.
  if (!Array.isArray(parsed) && parsed !== null && typeof parsed === 'object') {
    const wrapped = Object.values(parsed as Record<string, unknown>).find(Array.isArray);
    if (wrapped) {
      parsed = wrapped;
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Field description: LLM did not return a JSON array.');
  }

  // Validate and filter to only well-formed entries
  const results: FieldDescriptionResult[] = (parsed as unknown[])
    .filter(
      (item): item is { id: string; aiDescription: string } =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        typeof (item as Record<string, unknown>).aiDescription === 'string',
    )
    .map((item) => ({
      id: item.id,
      aiDescription: item.aiDescription.trim(),
    }));

  return results;
}
