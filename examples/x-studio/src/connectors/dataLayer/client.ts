/**
 * Typed client for the MUI data layer consumer API.
 *
 * - `GET  /api/v1/schema` lists the entities the caller can read.
 * - `POST /api/v1/query` runs a batch of queries, each with its own result or error.
 *
 * The types mirror `@repo/data-layer-contracts` (`schema.ts`, `query.ts`, `errors.ts`), which
 * is not published, so keep them in sync by hand.
 */

export type DataLayerFieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json';

export interface DataLayerField {
  name: string;
  type: DataLayerFieldType;
  nullable: boolean;
  filterable: boolean;
  sortable: boolean;
}

export interface DataLayerEntity {
  name: string;
  label: string;
  description: string | null;
  primaryKey: string | null;
  fields: DataLayerField[];
  /** Fields every query must filter with a top-level `eq`. */
  requiredFilters: string[];
  access: { read: boolean; rowFiltered: boolean };
}

export interface DataLayerSchema {
  entities: DataLayerEntity[];
}

export type DataLayerFilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'contains'
  | 'startsWith'
  | 'isNull'
  | 'isNotNull';

export type DataLayerScalar = string | number | boolean | null;

export type DataLayerFilter =
  | { and: DataLayerFilter[] }
  | { or: DataLayerFilter[] }
  | { not: DataLayerFilter }
  | { field: string; op: DataLayerFilterOp; value?: DataLayerScalar | DataLayerScalar[] };

export interface DataLayerQuery {
  entity: string;
  select?: string[];
  where?: DataLayerFilter;
  orderBy?: { field: string; direction?: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export interface DataLayerResultMeta {
  returned: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** The source could not evaluate the full result; `warnings` says why. */
  partial: boolean;
  durationMs: number;
  warnings?: string[];
}

export interface DataLayerQueryResult {
  data: Record<string, unknown>[];
  meta: DataLayerResultMeta;
}

type QueryResultEntry =
  | { id: string; status: 'ok'; data: Record<string, unknown>[]; meta: DataLayerResultMeta }
  | { id: string; status: 'error'; error: DataLayerErrorBody };

export interface DataLayerErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Upper bounds from the contracts' `QUERY_LIMITS`. A server may set lower ones. */
export const DATA_LAYER_LIMITS = { maxBatch: 10, maxLimit: 1000, maxOffset: 100_000 } as const;

/** An error envelope from the data layer: a request failure, or one failed query in a batch. */
export class DataLayerError extends Error {
  readonly code: string;

  readonly details?: Record<string, unknown>;

  readonly requestId?: string;

  constructor(body: DataLayerErrorBody, requestId?: string) {
    const field = typeof body.details?.field === 'string' ? ` (field: ${body.details.field})` : '';
    // Widgets render `message` as is, so the code goes into it.
    super(`${body.code}: ${body.message}${field}`);
    this.name = 'DataLayerError';
    this.code = body.code;
    this.details = body.details;
    this.requestId = requestId;
  }
}

export interface DataLayerClientOptions {
  /** Origin of the data layer, or a same-origin proxy path such as `/data-layer`. */
  baseUrl: string;
  /** A `dl_...` API key. Omit it when a proxy adds the `Authorization` header. */
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export interface DataLayerClient {
  getSchema(signal?: AbortSignal): Promise<DataLayerSchema>;
  /** Queries made in the same tick share one batch request, up to `maxBatch` per request. */
  query(query: DataLayerQuery): Promise<DataLayerQueryResult>;
}

interface Pending {
  query: DataLayerQuery;
  resolve: (result: DataLayerQueryResult) => void;
  reject: (error: unknown) => void;
}

export function createDataLayerClient(options: DataLayerClientOptions): DataLayerClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchFn(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const envelope = body as { error?: DataLayerErrorBody; requestId?: string } | null;
      if (envelope?.error?.code) {
        throw new DataLayerError(envelope.error, envelope.requestId);
      }
      throw new DataLayerError({
        code: `HTTP_${response.status}`,
        message: response.statusText || 'The data layer request failed.',
      });
    }
    // An SPA fallback answers 200 with HTML when nothing proxies the path.
    if (body === null) {
      throw new DataLayerError({
        code: 'INVALID_RESPONSE',
        message: `${baseUrl}${path} did not return JSON. Check the data layer URL or proxy.`,
      });
    }
    return body as T;
  }

  let queue: Pending[] = [];

  async function sendBatch(batch: Pending[]) {
    try {
      const body = await request<{ results: QueryResultEntry[]; requestId: string }>(
        '/api/v1/query',
        {
          method: 'POST',
          body: JSON.stringify({
            queries: batch.map((item, index) => ({ id: `q${index}`, ...item.query })),
          }),
        },
      );
      const byId = new Map(body.results.map((result) => [result.id, result]));
      batch.forEach((item, index) => {
        const result = byId.get(`q${index}`);
        if (!result) {
          item.reject(new DataLayerError({ code: 'INTERNAL', message: 'Missing query result.' }));
        } else if (result.status === 'error') {
          item.reject(new DataLayerError(result.error, body.requestId));
        } else {
          item.resolve({ data: result.data, meta: result.meta });
        }
      });
    } catch (error) {
      batch.forEach((item) => item.reject(error));
    }
  }

  function flush() {
    const pending = queue;
    queue = [];
    for (let i = 0; i < pending.length; i += DATA_LAYER_LIMITS.maxBatch) {
      void sendBatch(pending.slice(i, i + DATA_LAYER_LIMITS.maxBatch));
    }
  }

  return {
    getSchema(signal) {
      return request<DataLayerSchema>('/api/v1/schema', { signal });
    },
    query(query) {
      return new Promise((resolve, reject) => {
        if (queue.length === 0) {
          setTimeout(flush, 0);
        }
        queue.push({ query, resolve, reject });
      });
    },
  };
}
