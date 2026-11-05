import { describe, expect, it, vi } from 'vitest';
import { createDataLayerClient, DataLayerError } from './client';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okResult(id: string, data: Record<string, unknown>[]) {
  return {
    id,
    status: 'ok',
    data,
    meta: { returned: data.length, limit: 100, offset: 0, hasMore: false, partial: false },
  };
}

describe('createDataLayerClient', () => {
  it('sends the API key and reads the schema', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ entities: [] }));
    const client = createDataLayerClient({ baseUrl: 'http://dl/', apiKey: 'dl_x', fetchFn });

    await expect(client.getSchema()).resolves.toEqual({ entities: [] });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://dl/api/v1/schema',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer dl_x' }),
      }),
    );
  });

  it('batches queries made in the same tick into one request', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { queries } = JSON.parse(String(init?.body)) as { queries: { id: string }[] };
      return jsonResponse({
        requestId: 'req_1',
        results: queries.map((query) => okResult(query.id, [{ id: query.id }])),
      });
    });
    const client = createDataLayerClient({ baseUrl: '/data-layer', fetchFn });

    const [first, second] = await Promise.all([
      client.query({ entity: 'pets', limit: 10 }),
      client.query({ entity: 'pets', offset: 10 }),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({
      queries: [
        { id: 'q0', entity: 'pets', limit: 10 },
        { id: 'q1', entity: 'pets', offset: 10 },
      ],
    });
    expect(first.data).toEqual([{ id: 'q0' }]);
    expect(second.data).toEqual([{ id: 'q1' }]);
  });

  it('splits a batch at the query limit', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { queries } = JSON.parse(String(init?.body)) as { queries: { id: string }[] };
      return jsonResponse({
        requestId: 'req',
        results: queries.map((query) => okResult(query.id, [])),
      });
    });
    const client = createDataLayerClient({ baseUrl: '/data-layer', fetchFn });

    await Promise.all(Array.from({ length: 12 }, () => client.query({ entity: 'pets' })));

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('rejects only the failed query of a batch, with its error code', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        requestId: 'req_2',
        results: [
          okResult('q0', [{ id: 1 }]),
          {
            id: 'q1',
            status: 'error',
            error: {
              code: 'FIELD_NOT_ACCESSIBLE',
              message: 'Field is not accessible.',
              details: { field: 'secret' },
            },
          },
        ],
      }),
    );
    const client = createDataLayerClient({ baseUrl: '/data-layer', fetchFn });

    const [ok, failed] = await Promise.allSettled([
      client.query({ entity: 'pets' }),
      client.query({ entity: 'pets', select: ['secret'] }),
    ]);

    expect(ok.status).toBe('fulfilled');
    expect(failed.status).toBe('rejected');
    const error = (failed as PromiseRejectedResult).reason as DataLayerError;
    expect(error).toBeInstanceOf(DataLayerError);
    expect(error.code).toBe('FIELD_NOT_ACCESSIBLE');
    expect(error.requestId).toBe('req_2');
    expect(error.message).toBe('FIELD_NOT_ACCESSIBLE: Field is not accessible. (field: secret)');
  });

  it('turns an error envelope into a DataLayerError', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        {
          error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' },
          requestId: 'req_3',
        },
        401,
      ),
    );
    const client = createDataLayerClient({ baseUrl: '/data-layer', fetchFn });

    await expect(client.getSchema()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'UNAUTHENTICATED: Sign in to continue.',
      requestId: 'req_3',
    });
  });

  it('rejects a successful response that is not JSON', async () => {
    const fetchFn = vi.fn(async () => new Response('<!doctype html>', { status: 200 }));
    const client = createDataLayerClient({ baseUrl: '/data-layer', fetchFn });

    await expect(client.getSchema()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reports a non-envelope failure with its HTTP status', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const client = createDataLayerClient({ baseUrl: '/data-layer', fetchFn });

    await expect(client.getSchema()).rejects.toMatchObject({
      code: 'HTTP_502',
      message: 'HTTP_502: Bad Gateway',
    });
  });
});
