'use client';
import * as React from 'react';
import type { StudioState, StudioWidget } from '../../../models';
import {
  useStudioController,
  useStudioSelector,
  selectActivePage,
  selectDashboard,
} from '../../../context';
import { useStudioUIConfig } from '../../../internals/StudioUIConfigContext';
import { buildWidgetDataSummary } from '../../StudioChatPanel/generateInsight';

const CACHE_PREFIX = 'studio:textAI:v1';

interface CacheEntry {
  hash: string;
  markdown: string;
}

function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
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

function writeCache(key: string, hash: string, markdown: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const entry: CacheEntry = { hash, markdown };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Storage full or blocked — swallow
  }
}

function buildPageSnapshot(widgetId: string, state: StudioState): string {
  const activePage = state.pages[state.dashboard.activePageId];
  if (!activePage) {
    return '';
  }
  const widgetIds = activePage.widgetRows.flat().sort();
  return widgetIds
    .filter((id) => {
      const w = state.widgets[id];
      return w && w.kind !== 'text' && id !== widgetId;
    })
    .flatMap((id) => {
      const w = state.widgets[id] as StudioWidget;
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

  const { snapshot, hash, cacheKey } = React.useMemo(() => {
    const state = controller.getState();
    const snap = buildPageSnapshot(widgetId, state);
    const h = djb2Hash(`${prompt}\n${snap}`);
    const key = `${CACHE_PREFIX}:${dashboard.id}:${dashboard.activePageId}:${widgetId}:${h}`;
    return { snapshot: snap, hash: h, cacheKey: key };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activePage is the reactive dependency that covers widget/data changes
  }, [activePage, dashboard, widgetId, controller, prompt]);

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
        const serializableState = {
          ...state,
          dataSources: Object.fromEntries(
            Object.entries(state.dataSources).map(([id, source]) => {
              const {
                rows: _rows,
                adapter: _adapter,
                ...rest
              } = source as unknown as {
                rows?: unknown;
                adapter?: unknown;
              } & Record<string, unknown>;
              return [id, rest];
            }),
          ),
        };

        const response = await fetch(chatUrl, {
          method: 'POST',
          signal: abort.signal,
          headers: { 'Content-Type': 'application/json', ...aiConfig.headers },
          body: JSON.stringify({
            messages: [{ id: 'prompt', role: 'user', parts: [{ type: 'text', text: prompt }] }],
            dashboardState: serializableState,
            pageSnapshot: snapshot || undefined,
            // Restrict to read-only tools so no dashboard state mutations occur
            allowedTools: ['execute_query', 'summarise_page'],
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';

        outer: while (true) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) {
              continue;
            }
            const payload = line.slice(6).trim();
            if (!payload) {
              continue;
            }
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }

            if (event.type === 'text-delta') {
              content += String(event.delta ?? '');
            } else if (event.type === 'tool-approval-request') {
              // Auto-approve: text widget AI only runs read-only tools, but guard just in case
              fetch(approvalUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...aiConfig.headers },
                body: JSON.stringify({ id: event.toolCallId, approved: true }),
              }).catch(() => {});
            } else if (event.type === 'finish') {
              break outer;
            } else if (event.type === 'error') {
              throw new Error(String(event.message ?? 'AI error'));
            }
          }
        }

        if (abort.signal.aborted) {
          return;
        }

        writeCache(cacheKey, hash, content);
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
