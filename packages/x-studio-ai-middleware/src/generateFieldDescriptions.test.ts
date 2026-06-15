/**
 * Unit tests for `generateFieldDescriptions`.
 *
 * Exercises the request construction (model/headers/token budget), the
 * happy-path JSON parsing, the error paths (non-OK response, unparseable or
 * non-array content), and the malformed-entry filtering — all against a
 * stubbed global `fetch` so no LLM is contacted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateFieldDescriptions, type FieldDescriptionInput } from './generateFieldDescriptions';

const OPTIONS = { endpoint: 'https://llm.test/v1/chat', apiKey: 'sk-test' };

const FIELDS: FieldDescriptionInput[] = [
  { id: 'order_total', label: 'Order Total', type: 'number', sampleValues: [12.5, 200] },
  { id: 'country', label: 'Country', type: 'string', sampleValues: ['US', 'DE'] },
];

/** Stub global fetch with a single OpenAI-style chat completion response. */
function stubFetch(content: string, init: { ok?: boolean; status?: number; text?: string } = {}) {
  const ok = init.ok ?? true;
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: 'ERR',
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => init.text ?? '',
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function requestBody(fn: ReturnType<typeof stubFetch>) {
  return JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateFieldDescriptions', () => {
  it('returns an empty array and skips the network call for zero fields', async () => {
    const fn = stubFetch('[]');
    expect(await generateFieldDescriptions('Orders', [], OPTIONS)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns the parsed descriptions on the happy path', async () => {
    stubFetch(
      JSON.stringify([
        { id: 'order_total', aiDescription: 'Total order amount.' },
        { id: 'country', aiDescription: 'Customer country.' },
      ]),
    );
    const result = await generateFieldDescriptions('Orders', FIELDS, OPTIONS);
    expect(result).toEqual([
      { id: 'order_total', aiDescription: 'Total order amount.' },
      { id: 'country', aiDescription: 'Customer country.' },
    ]);
  });

  it('trims whitespace from descriptions and drops malformed entries', async () => {
    stubFetch(
      JSON.stringify([
        { id: 'order_total', aiDescription: '  Padded.  ' },
        null,
        { id: 'no_desc' },
        { aiDescription: 'no id' },
        { id: 42, aiDescription: 'non-string id' },
      ]),
    );
    const result = await generateFieldDescriptions('Orders', FIELDS, OPTIONS);
    expect(result).toEqual([{ id: 'order_total', aiDescription: 'Padded.' }]);
  });

  describe('request construction', () => {
    it('defaults the model to gpt-4o and sends a JSON-object response format', async () => {
      const fn = stubFetch('[]');
      await generateFieldDescriptions('Orders', FIELDS, OPTIONS);
      const body = requestBody(fn);
      expect(body.model).toBe('gpt-4o');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');
    });

    it('honors a model override', async () => {
      const fn = stubFetch('[]');
      await generateFieldDescriptions('Orders', FIELDS, { ...OPTIONS, model: 'gpt-4o-mini' });
      expect(requestBody(fn).model).toBe('gpt-4o-mini');
    });

    it('caps max_tokens at 4096 regardless of field count', async () => {
      const many: FieldDescriptionInput[] = Array.from({ length: 30 }, (_, i) => ({
        id: `f${i}`,
        label: `F${i}`,
        type: 'number',
      }));
      const fn = stubFetch('[]');
      await generateFieldDescriptions('Big', many, OPTIONS);
      expect(requestBody(fn).max_tokens).toBe(4096); // min(200*30, 4096)
    });

    it('scales max_tokens with field count below the cap', async () => {
      const fn = stubFetch('[]');
      await generateFieldDescriptions('Orders', FIELDS, OPTIONS);
      expect(requestBody(fn).max_tokens).toBe(400); // 200 * 2
    });

    it('sends an Authorization header when an apiKey is provided', async () => {
      const fn = stubFetch('[]');
      await generateFieldDescriptions('Orders', FIELDS, OPTIONS);
      const headers = (fn.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test');
    });

    it('omits the Authorization header when no apiKey is provided', async () => {
      const fn = stubFetch('[]');
      await generateFieldDescriptions('Orders', FIELDS, { endpoint: OPTIONS.endpoint });
      const headers = (fn.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('forwards extra headers', async () => {
      const fn = stubFetch('[]');
      await generateFieldDescriptions('Orders', FIELDS, {
        ...OPTIONS,
        headers: { 'x-org': 'acme' },
      });
      const headers = (fn.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['x-org']).toBe('acme');
    });
  });

  describe('error handling', () => {
    it('throws with the status and body text on a non-OK response', async () => {
      stubFetch('', { ok: false, status: 429, text: 'rate limited' });
      await expect(generateFieldDescriptions('Orders', FIELDS, OPTIONS)).rejects.toThrow(
        /429 rate limited/,
      );
    });

    it('throws when the model returns unparseable content', async () => {
      stubFetch('not json at all');
      await expect(generateFieldDescriptions('Orders', FIELDS, OPTIONS)).rejects.toThrow(
        /unparseable JSON/,
      );
    });

    it('throws when the parsed content is valid JSON but not an array', async () => {
      stubFetch(JSON.stringify({ id: 'x', aiDescription: 'y' }));
      await expect(generateFieldDescriptions('Orders', FIELDS, OPTIONS)).rejects.toThrow(
        /did not return a JSON array/,
      );
    });
  });
});
