/**
 * Projecting a `StudioState` down to what the model is allowed to see.
 *
 * A different job from capping (`requestCaps.ts`/`valueCaps.ts`): capping bounds how BIG a value
 * may be, this decides WHICH values exist at all. `rows` and `adapter` are stripped outright —
 * raw table data is an exfiltration and token-bomb path that also contradicts the system prompt's
 * no-raw-data rule and defeats `privateMode`, and an adapter is a non-serializable host callback.
 * `describe_data_source` is the intentional, opt-in channel for sample rows; this is not.
 */
import type { StudioState, StudioDataSource } from '../models/studioTypes';
import { asString } from './promptCaps';
import { capTitle, capEntityId, MAX_DISTINCT_VALUES_IN_STATE_OUTPUT } from './valueCaps';

/**
 * Project a `StudioDataSource` down to AI-safe metadata for `get_dashboard_state`.
 *
 * Strips `rows` (raw live table data — an exfiltration / token-bomb path that also
 * contradicts the system prompt's no-raw-data rule and defeats `privateMode`) and
 * `adapter` (a non-serializable host callback) entirely, and caps
 * `fieldDistinctValues` per field with a `truncated` marker. `describe_data_source`
 * is the intentional, opt-in channel for sample rows — this dump is not.
 */
export function projectDataSourceMetadata(source: StudioDataSource): Record<string, unknown> {
  // `Object.create(null)`, not `{}`: these keys are DATABASE COLUMN
  // names, so a column literally named `__proto__` assigned an object value would
  // rewrite the prototype instead of creating an entry — that field's distinct
  // values would silently vanish from `get_dashboard_state` AND from the
  // `studio://dashboard/state` resource while everything reported success. The
  // sibling `capFieldDistinctValues` above already uses a null-prototype map over
  // the same key space, for the same reason.
  const cappedDistinct: Record<string, { values: string[]; truncated: boolean }> =
    Object.create(null);
  for (const [fieldId, values] of Object.entries(source.fieldDistinctValues ?? {})) {
    // `Array.isArray` before `.slice`: `fieldDistinctValues` is
    // client-supplied JSON on every path that does not go through
    // `capFieldDistinctValues` (which drops malformed entries for this exact
    // reason), so a `{ revenue: "abc" }` entry reached `.slice`/`.length` on a
    // non-array. A string would have `slice`d into a fake value list and a number
    // would have thrown a raw `TypeError` out of a read-only tool. Drop it instead:
    // an empty list would render as a `0 values` cardinality hint, inventing a fact
    // about the field.
    if (!Array.isArray(values)) {
      continue;
    }
    cappedDistinct[fieldId] = {
      values: values.slice(0, MAX_DISTINCT_VALUES_IN_STATE_OUTPUT),
      truncated: values.length > MAX_DISTINCT_VALUES_IN_STATE_OUTPUT,
    };
  }
  return {
    id: source.id,
    label: source.label,
    tableName: source.tableName,
    aiDescription: source.aiDescription,
    hidden: source.hidden,
    fields: source.fields,
    fieldDistinctValues: cappedDistinct,
  };
}

/**
 * Per-thread AI metadata emitted in the AI-safe state snapshot — the shape
 * `doc.ai` is reduced to. Deliberately carries NO `messages`: only enough for the
 * model to know which threads exist and how large each is.
 */
export interface ProjectedAIThread {
  id: string;
  name: string;
  updatedAt?: string;
  messageCount: number;
}

/** The AI-safe `doc.ai` replacement: thread metadata with all transcripts removed. */
export interface ProjectedAIState {
  activeThreadId?: string;
  threads: ProjectedAIThread[];
}

/** The AI-safe `{ doc, dataSources }` snapshot shared by both read surfaces. */
export interface ProjectedStateForAI {
  doc: Omit<StudioState['doc'], 'ai'> & { ai?: ProjectedAIState };
  dataSources: Record<string, unknown>;
}

/**
 * Project a `StudioState` down to the AI-safe `{ doc, dataSources }` snapshot that
 * both the `get_dashboard_state` TOOL and the `studio://dashboard/state` MCP
 * RESOURCE emit. This is the single home for the read-surface redaction contract —
 * previously the doc half was hand-copied across both call sites, so a leak (or a
 * new sensitive `StudioDoc` sub-partition) had to be remembered in two files.
 *
 * Two redactions happen here, in ONE place so the two surfaces cannot drift:
 *
 * 1. `runtime.dataSources` is projected through `projectDataSourceMetadata`, which
 *    strips `rows` (raw live table data) and `adapter` (a non-serializable host
 *    callback) and caps `fieldDistinctValues`. Emitting the raw `StudioState` here
 *    would leak live rows into the model context — a token bomb and an exfiltration
 *    path that defeats `privateMode`.
 * 2. `doc.ai` is reduced to per-thread METADATA (`{ id, name, updatedAt,
 *    messageCount }`) with every message transcript removed. `StudioAIChatThread.messages`
 *    holds the FULL history of EVERY thread (not just the active one), and `doc.ai`
 *    is persisted with shareable dashboards — so echoing it verbatim would dump every
 *    conversation's transcript back to the provider (cross-conversation information
 *    disclosure + an unbounded token bomb). The model already has the active thread as
 *    its live message array, so it needs no chat history in this snapshot. The
 *    surviving `id`/`name`/`updatedAt` are length-capped here because
 *    this is their ONLY chokepoint: `rename_thread` bounds the name it writes, but
 *    `doc.ai` arrives from the request body and `capIncomingDashboardState` does not
 *    touch that sub-partition.
 *
 * What is deliberately NOT redacted: the rest of `doc` is spread through verbatim,
 * including `relationships`, `expressionFields` and `filterPresets`. They are
 * authored dashboard structure the model legitimately needs, not host or user
 * secrets — but note that they ARE emitted here (an earlier comment on
 * `capIncomingDashboardState` wrongly described them as non-interpolated), so they
 * are bounded only by `capToolOutput` on the chat path.
 */
export function projectStateForAI(state: StudioState): ProjectedStateForAI {
  // `Object.create(null)`, not `{}`: the keys are client-supplied data
  // source ids, and a source keyed `__proto__` would be silently dropped from BOTH
  // read surfaces (assigning an object to `{}`'s `__proto__` rewrites the prototype
  // rather than creating an entry) — the model would then be told a `sourceId` the
  // dashboard really has does not exist. The sibling `capDataSources` uses a
  // null-prototype map over the same key space for the same reason.
  const dataSources: Record<string, unknown> = Object.create(null);
  for (const [id, source] of Object.entries(state.runtime.dataSources)) {
    dataSources[id] = projectDataSourceMetadata(source);
  }
  const { ai, ...docWithoutAi } = state.doc;
  const redactedAi: ProjectedAIState | undefined = ai
    ? {
        ...(ai.activeThreadId ? { activeThreadId: capEntityId(asString(ai.activeThreadId)) } : {}),
        // `id`/`name` are length-capped here. Unlike every other string
        // this snapshot emits they have no write-source cap: `rename_thread` bounds
        // the name it SETS to 40 chars, but `doc.ai` arrives from the request body
        // and `capIncomingDashboardState` passes the whole `ai` sub-partition through
        // untouched, so a client-supplied 50 MB thread name landed verbatim in
        // `get_dashboard_state` output and in `studio://dashboard/state`.
        threads: (Array.isArray(ai.threads) ? ai.threads : []).map((thread) => ({
          id: capEntityId(asString(thread?.id)),
          name: capTitle(asString(thread?.name)),
          ...(thread?.updatedAt ? { updatedAt: capTitle(asString(thread.updatedAt)) } : {}),
          messageCount: Array.isArray(thread?.messages) ? thread.messages.length : 0,
        })),
      }
    : undefined;
  return {
    doc: { ...docWithoutAi, ...(redactedAi ? { ai: redactedAi } : {}) },
    dataSources,
  };
}
