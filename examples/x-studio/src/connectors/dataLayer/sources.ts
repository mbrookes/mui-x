/**
 * Turns data layer entities into Studio data sources.
 *
 * Each entity becomes one `StudioDataSource` whose adapter pushes the widget's filter tree down to
 * `POST /api/v1/query`. A chart that can read pre-aggregated rows gets one row per group from the
 * data layer's `aggregate`. Every other widget, and any aggregate the source can't compute, reads
 * raw rows, which Studio aggregates itself.
 */
import { createDefaultStudioState } from '@mui/x-studio';
import type {
  StudioDataField,
  StudioDataSource,
  StudioDataSourceAdapter,
  StudioFilterState,
  StudioState,
  StudioWidget,
} from '@mui/x-studio';
import {
  DATA_LAYER_LIMITS,
  type DataLayerClient,
  type DataLayerEntity,
  type DataLayerField,
  type DataLayerFieldType,
  type DataLayerQuery,
  DataLayerError,
} from './client';
import { toDataLayerWhere } from './filters';
import { fromDataLayerAggregateRows, toDataLayerAggregate } from './aggregates';

/** Rows one widget reads before the adapter stops paging and reports truncation. */
export const DATA_LAYER_DEFAULT_MAX_ROWS = 5000;

const SOURCE_PREFIX = 'dl-';

export function dataLayerSourceId(entityName: string): string {
  return `${SOURCE_PREFIX}${entityName}`;
}

/** What one widget read: shown by the host so truncated or partial data is never silent. */
export interface DataLayerReadNotice {
  widgetId: string;
  sourceId: string;
  /** The entity label. */
  label: string;
  /** Raw rows, or groups when `aggregated` is true. */
  rows: number;
  /** The data layer computed the aggregates, so `rows` counts groups. */
  aggregated: boolean;
  /** `hasMore` was still true when the adapter stopped paging. */
  truncated: boolean;
  /** The source could not evaluate the full result. */
  partial: boolean;
  warnings: string[];
}

export interface DataLayerAdapterOptions {
  /** Defaults to `DATA_LAYER_DEFAULT_MAX_ROWS`. A descriptor `limit` takes precedence. */
  maxRows?: number;
  onRead?: (notice: DataLayerReadNotice) => void;
}

const STUDIO_TYPES: Record<DataLayerFieldType, StudioDataField['type']> = {
  string: 'string',
  integer: 'number',
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  datetime: 'datetime',
  // Studio has no JSON type; the adapter serializes these values to strings.
  json: 'string',
};

export function toStudioField(field: DataLayerField): StudioDataField {
  return { id: field.name, label: field.name, type: STUDIO_TYPES[field.type] };
}

interface PagedRead {
  rows: Record<string, unknown>[];
  /** The source had more rows or groups when paging stopped. */
  hasMore: boolean;
  partial: boolean;
  warnings: string[];
}

export function createDataLayerAdapter(
  client: DataLayerClient,
  entity: DataLayerEntity,
  options: DataLayerAdapterOptions = {},
): StudioDataSourceAdapter {
  const fieldTypes = new Map(entity.fields.map((field) => [field.name, field.type]));
  const jsonFields = entity.fields.filter((field) => field.type === 'json').map((f) => f.name);

  // Set when the source answers that it can't compute aggregates at all, for example OpenAPI.
  let aggregatesUnsupported = false;

  async function readPages(
    query: Omit<DataLayerQuery, 'limit' | 'offset'>,
    maxRows: number,
  ): Promise<PagedRead> {
    const rows: Record<string, unknown>[] = [];
    const warnings = new Set<string>();
    let partial = false;
    let hasMore = true;
    while (hasMore && rows.length < maxRows) {
      // eslint-disable-next-line no-await-in-loop -- each page starts at the previous page's end
      const { data, meta } = await client.query({
        ...query,
        limit: Math.min(DATA_LAYER_LIMITS.maxLimit, maxRows - rows.length),
        offset: rows.length,
      });
      rows.push(...data);
      partial ||= meta.partial;
      meta.warnings?.forEach((warning) => warnings.add(warning));
      hasMore = meta.hasMore && data.length > 0;
    }
    return { rows, hasMore, partial, warnings: [...warnings] };
  }

  return {
    async getRows(descriptor) {
      const where = toDataLayerWhere(descriptor.filter, descriptor.sourceId, fieldTypes);
      const maxRows = Math.min(
        descriptor.limit ?? options.maxRows ?? DATA_LAYER_DEFAULT_MAX_ROWS,
        DATA_LAYER_LIMITS.maxOffset,
      );
      const notify = (read: PagedRead, aggregated: boolean) =>
        options.onRead?.({
          widgetId: descriptor.widgetId,
          sourceId: descriptor.sourceId,
          label: entity.label,
          rows: read.rows.length,
          aggregated,
          truncated: read.hasMore,
          partial: read.partial,
          warnings: read.warnings,
        });

      const plan = aggregatesUnsupported
        ? { fallback: 'the source cannot compute aggregates' }
        : toDataLayerAggregate(descriptor, fieldTypes);
      if ('aggregate' in plan) {
        try {
          const read = await readPages(
            { entity: entity.name, where, aggregate: plan.aggregate },
            maxRows,
          );
          notify(read, true);
          return {
            rows: fromDataLayerAggregateRows(read.rows, plan.keys),
            totalCount: read.hasMore ? undefined : read.rows.length,
            isTruncated: read.hasMore || read.partial,
            preAggregated: true,
          };
        } catch (error) {
          if (!(error instanceof DataLayerError) || error.code !== 'OPERATOR_NOT_SUPPORTED') {
            throw error;
          }
          // Without a field, the source itself has no aggregate push-down.
          aggregatesUnsupported ||= error.details?.field === undefined;
          logFallback(descriptor.widgetId, error.message);
        }
      } else if (descriptor.aggregations?.length) {
        logFallback(descriptor.widgetId, plan.fallback);
      }

      // Expression and related-source fields are not entity fields; Studio computes them.
      const select = descriptor.select.filter((id) => fieldTypes.has(id));
      const read = await readPages(
        { entity: entity.name, select: select.length > 0 ? select : undefined, where },
        maxRows,
      );
      notify(read, false);
      const { rows, hasMore, partial } = read;
      return {
        rows: jsonFields.length > 0 ? rows.map((row) => serializeJson(row, jsonFields)) : rows,
        totalCount: hasMore ? undefined : rows.length,
        isTruncated: hasMore || partial,
      };
    },
  };
}

function logFallback(widgetId: string, reason: string): void {
  // eslint-disable-next-line no-console
  console.debug(`[data-layer] ${widgetId} reads raw rows: ${reason}.`);
}

function serializeJson(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const copy = { ...row };
  for (const field of fields) {
    if (copy[field] !== null && typeof copy[field] === 'object') {
      copy[field] = JSON.stringify(copy[field]);
    }
  }
  return copy;
}

export function toStudioDataSource(
  client: DataLayerClient,
  entity: DataLayerEntity,
  options?: DataLayerAdapterOptions,
): StudioDataSource {
  return {
    id: dataLayerSourceId(entity.name),
    label: entity.label,
    tableName: entity.name,
    fields: entity.fields.map(toStudioField),
    aiDescription: entity.description ?? undefined,
    adapter: createDataLayerAdapter(client, entity, options),
  };
}

const STARTER_COLUMNS = 8;

/**
 * A starter dashboard with one grid per readable entity, so the data layer shows rows on first
 * load. Entities with `requiredFilters` get an empty widget filter for each required field.
 */
export function createDataLayerState(
  client: DataLayerClient,
  entities: DataLayerEntity[],
  options?: DataLayerAdapterOptions,
): StudioState {
  const readable = entities.filter((entity) => entity.access.read);
  const pageId = 'page-data-layer';
  const dataSources: Record<string, StudioDataSource> = {};
  const widgets: Record<string, StudioWidget> = {};
  const filters: StudioFilterState[] = [];

  for (const entity of readable) {
    const source = toStudioDataSource(client, entity, options);
    dataSources[source.id] = source;
    const widgetId = `widget-${source.id}`;
    widgets[widgetId] = {
      id: widgetId,
      kind: 'grid',
      title: entity.label,
      titleMode: 'manual',
      sourceId: source.id,
      config: {
        columns: source.fields.slice(0, STARTER_COLUMNS).map((field) => ({ fieldId: field.id })),
      },
    };
    for (const name of entity.requiredFilters) {
      const field = source.fields.find((candidate) => candidate.id === name);
      filters.push({
        id: `filter-${source.id}-${name}`,
        field: name,
        operator: 'equals',
        value: null,
        fieldType: field?.type,
        filterSourceId: source.id,
        scope: { kind: 'widget', widgetId },
      });
    }
  }

  return createDefaultStudioState({
    doc: {
      dashboard: { id: 'dashboard-data-layer', title: 'Data layer', activePageId: pageId },
      pages: {
        [pageId]: {
          id: pageId,
          title: 'Entities',
          widgetRows: Object.keys(widgets).map((widgetId) => [widgetId]),
        },
      },
      widgets,
      filters,
    },
    runtime: { dataSources },
  });
}
