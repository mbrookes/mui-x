'use client';
import * as React from 'react';
import type { StudioState, StudioWidget } from '../../../models';
import {
  useStudioController,
  useStudioSelector,
  selectActivePage,
  selectDashboard,
  selectWidgets,
  selectDataSources,
} from '../../../context';
import { useStudioUIConfig } from '../../../internals/StudioUIConfigContext';
import { buildWidgetDataSummary } from '../../StudioChatPanel/generateInsight';
import { parseSSEStream, serializeDashboardState } from '../../StudioChatPanel/sseUtils';

const CACHE_PREFIX = 'studio:textAI:v1';

/**
 * The only tools this hook's chat request declares via `allowedTools` — this widget
 * runs headless (no chat UI, so no human can review a `tool-approval-request` card
 * the way the main `StudioChatPanel` lets a user do). The SSE `tool-approval-request`
 * handler below auto-approves ONLY requests whose own `toolName` is in this list,
 * as a client-side guard against a server that (whether by bug or by an
 * out-of-sync deploy) sends an approval request for a tool outside the restriction
 * this request itself asked for — see finding 3.15. This is defense in depth, not a
 * replacement for the server enforcing `allowedTools`: a compromised/buggy server
 * could still lie about `toolName` on the wire. Kept as a single source shared with
 * the request body so the two can't drift apart.
 */
const READ_ONLY_TOOL_NAMES = ['query_data_source', 'summarise_page'] as const;

/**
 * Cap on the number of cached AI responses kept in `localStorage` under
 * {@link CACHE_PREFIX}. Without a cap, every distinct (dashboard, page, widget,
 * prompt+data hash) combination a user ever generates leaves behind its own
 * entry forever — `localStorage` has no TTL/LRU of its own, so the cache grows
 * unbounded across the lifetime of the browser profile (finding 3.6). Kept
 * intentionally simple: a hard count cap with oldest-first eviction, not a full
 * cache library.
 */
const MAX_CACHE_ENTRIES = 50;

interface CacheEntry {
  markdown: string;
  /** Epoch ms this entry was written. Used only to pick eviction order (oldest
   * first) when the cache exceeds {@link MAX_CACHE_ENTRIES} — not read back for
   * cache-hit/miss decisions (the hash is already embedded in the cache key). */
  createdAt: number;
}

function djb2Hash(s: string): string {
  let h = 5381;
  // eslint-disable-next-line no-plusplus
  for (let i = 0; i < s.length; i++) {
    // eslint-disable-next-line no-bitwise
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  // eslint-disable-next-line no-bitwise
  return (h >>> 0).toString(36);
}

function readCache(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return (JSON.parse(raw) as CacheEntry).markdown ?? null;
  } catch {
    return null;
  }
}

function writeCache(key: string, markdown: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const entry: CacheEntry = { markdown, createdAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(entry));
    evictOldestEntries();
  } catch {
    // Storage full or blocked — swallow
  }
}

/**
 * Enforce {@link MAX_CACHE_ENTRIES} on the `CACHE_PREFIX`-namespaced entries in
 * `localStorage`, removing the oldest (by `createdAt`) first. Best-effort: any
 * failure reading/parsing an entry treats it as the oldest so it's cleaned up
 * rather than left to accumulate forever.
 */
function evictOldestEntries(): void {
  try {
    const namespacePrefix = `${CACHE_PREFIX}:`;
    const entries: { key: string; createdAt: number }[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(namespacePrefix)) {
        continue;
      }
      let createdAt = 0;
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? (JSON.parse(raw) as Partial<CacheEntry>) : null;
        createdAt = typeof parsed?.createdAt === 'number' ? parsed.createdAt : 0;
      } catch {
        // Corrupt entry — treat as oldest.
      }
      entries.push({ key, createdAt });
    }
    if (entries.length <= MAX_CACHE_ENTRIES) {
      return;
    }
    entries.sort((a, b) => a.createdAt - b.createdAt);
    const excess = entries.length - MAX_CACHE_ENTRIES;
    for (let i = 0; i < excess; i += 1) {
      localStorage.removeItem(entries[i].key);
    }
  } catch {
    // Storage inaccessible — swallow, matches writeCache's own guard.
  }
}

function buildPageSnapshot(widgetId: string, state: StudioState): string {
  const activePage = state.doc.pages[state.doc.dashboard.activePageId];
  if (!activePage) {
    return '';
  }
  const widgetIds = activePage.widgetRows.flat().sort();
  return widgetIds
    .filter((id) => {
      const w = state.doc.widgets[id];
      return w && w.kind !== 'text' && id !== widgetId;
    })
    .flatMap((id) => {
      const w = state.doc.widgets[id] as StudioWidget;
      const summary = buildWidgetDataSummary(w, state, { sampling: 'stride', maxRows: 20 });
      if (!summary) {
        return [];
      }
      return [`### ${w.title || w.kind} (${w.kind})\n${summary}`];
    })
    .join('\n\n');
}

export interface TextWidgetAIResult {
  markdown: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useTextWidgetAI(widgetId: string, prompt: string): TextWidgetAIResult {
  const { aiConfig } = useStudioUIConfig();
  const controller = useStudioController();
  const activePage = useStudioSelector(selectActivePage);
  const dashboard = useStudioSelector(selectDashboard);
  // `buildPageSnapshot` (via `buildWidgetDataSummary`) reads sibling widget configs
  // from `doc.widgets` and row data from `runtime.dataSources` — neither changes
  // `activePage`/`dashboard` identity (finding 3.15), so both must be subscribed to
  // directly or `setDataSourceRows`/`upsertDataSource`/a sibling-widget config edit
  // would leave this memo (and the cached markdown it feeds) stale until a manual
  // `refresh()`.
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);

  const { snapshot, hash, cacheKey } = React.useMemo(() => {
    const state = controller.getState();
    const snap = buildPageSnapshot(widgetId, state);
    const h = djb2Hash(`${prompt}\n${snap}`);
    const key = `${CACHE_PREFIX}:${dashboard.id}:${dashboard.activePageId}:${widgetId}:${h}`;
    return { snapshot: snap, hash: h, cacheKey: key };
    // `widgets`/`dataSources` are read only to force recomputation when the state
    // `buildPageSnapshot` reads changes identity — the memo body itself re-derives
    // everything from `controller.getState()` rather than from these values directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- widgets/dataSources are used as reactive triggers only, see comment above
  }, [activePage, dashboard, widgetId, controller, prompt, widgets, dataSources]);

  const [markdown, setMarkdown] = React.useState<string | null>(() => readCache(cacheKey));
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = React.useState(0);

  const refresh = React.useCallback(() => setRefreshSeq((s) => s + 1), []);

  React.useEffect(() => {
    if (!aiConfig?.endpoint || !prompt.trim()) {
      return undefined;
    }

    if (refreshSeq === 0) {
      const cached = readCache(cacheKey);
      if (cached) {
        setMarkdown(cached);
        setLoading(false);
        setError(null);
        return undefined;
      }
    }

    const abort = new AbortController();
    setLoading(true);
    setError(null);

    const baseUrl = aiConfig.endpoint.replace(/\/?$/, '');
    const chatUrl = `${baseUrl}/chat`;
    const approvalUrl = `${baseUrl}/approval`;

    (async () => {
      try {
        const state = controller.getState();
        const serializableState = serializeDashboardState(state);

        const response = await fetch(chatUrl, {
          method: 'POST',
          signal: abort.signal,
          headers: { 'Content-Type': 'application/json', ...aiConfig.headers },
          body: JSON.stringify({
            messages: [{ id: 'prompt', role: 'user', parts: [{ type: 'text', text: prompt }] }],
            dashboardState: serializableState,
            pageSnapshot: snapshot || undefined,
            // Restrict to read-only tools so no dashboard state mutations occur
            allowedTools: [...READ_ONLY_TOOL_NAMES],
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        let content = '';
        await parseSSEStream(response, (sseEvent) => {
          if (sseEvent.type === 'text-delta') {
            content += String(sseEvent.delta ?? '');
          } else if (sseEvent.type === 'tool-approval-request') {
            // Client-side guard (finding 3.15): this widget has no approval UI for a
            // human to review, so only auto-approve when the request's own `toolName`
            // is actually within the read-only allowlist this request declared above.
            // Blindly approving every request here would be safe only as long as the
            // server itself enforces `allowedTools` — this guard means a server that
            // (by bug, or drift between this endpoint and its `allowedTools` handling)
            // asks approval for e.g. a mutating tool gets no approval from this headless
            // caller, instead of an unconditional rubber stamp.
            const requestedToolName = String((sseEvent as { toolName?: unknown }).toolName ?? '');
            const approved = (READ_ONLY_TOOL_NAMES as readonly string[]).includes(
              requestedToolName,
            );
            fetch(approvalUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...aiConfig.headers },
              body: JSON.stringify({ id: sseEvent.toolCallId, approved }),
            }).catch(() => {});
          } else if (sseEvent.type === 'finish') {
            return false;
          } else if (sseEvent.type === 'error') {
            throw new Error(String(sseEvent.message ?? 'AI error'));
          }
          return undefined;
        });

        if (abort.signal.aborted) {
          return;
        }

        writeCache(cacheKey, content);
        setMarkdown(content);
        setLoading(false);
      } catch (err) {
        if (abort.signal.aborted) {
          return;
        }
        setLoading(false);
        setError(err instanceof Error ? err.message : 'Failed to generate content');
      }
    })();

    return () => abort.abort();
  }, [cacheKey, hash, refreshSeq, aiConfig, snapshot, prompt, controller]);

  return { markdown, loading, error, refresh };
}
