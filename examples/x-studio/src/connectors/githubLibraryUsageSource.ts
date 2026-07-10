/**
 * Client connectors for the "component library × X library" adoption charts
 * (currently: data grid libraries, and chart libraries).
 *
 * Each reads from this app's own API server (see src/server/index.ts +
 * src/server/githubLibraryUsage.ts), which proxies GitHub's code-search API
 * using a server-side token. The GitHub token never ships to the browser —
 * baking a personal access token into the client bundle via a VITE_ env var
 * would expose it to anyone who loads the page.
 *
 * `/api/*` requests resolve relative to the current origin: in production a
 * single Railway service serves both the built client and this API (see
 * railway.toml), so no base URL is needed; in local dev, `vite.config.ts`
 * proxies `/api` to the separately-running `pnpm server` process.
 *
 * Without the API server running, or when it has no GITHUB_SEARCH_TOKEN
 * configured, an endpoint returns an empty row set and the chart shows its
 * "no data" state rather than erroring.
 */
import type { StudioDataSource, StudioDataSourceAdapter } from '@mui/x-studio';

/** A `GET <endpoint>` returning `{ rows }` — the "current" (latest snapshot) shape. */
function createCurrentRowsConnector(endpoint: string, label: string) {
  let cachedRows: Record<string, unknown>[] | null = null;
  let inFlight: Promise<Record<string, unknown>[]> | null = null;

  async function prefetch(): Promise<Record<string, unknown>[]> {
    if (cachedRows !== null) {
      return cachedRows;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const res = await fetch(endpoint);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const data = (await res.json()) as { rows: Record<string, unknown>[] };
        cachedRows = data.rows;
        return cachedRows;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[x-studio] ${label} connector: could not reach ${endpoint} — is the API server ` +
            'running? (pnpm server)',
          err,
        );
        return [];
      }
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function createAdapter(): StudioDataSourceAdapter {
    return {
      async getRows() {
        return { rows: await prefetch() };
      },
    };
  }

  return { prefetch, createAdapter };
}

interface LibraryUsageSnapshot {
  weekOf: string;
  fetchedAt: number;
  rows: Record<string, unknown>[];
}

/**
 * A `GET <endpoint>` returning `{ snapshots }` — every captured weekly
 * snapshot, flattened into one row set with a `weekOf` on each row (row ids
 * are prefixed with the week so they stay unique across snapshots — the
 * server's per-cell id alone repeats every week).
 */
function createHistoryRowsConnector(endpoint: string, label: string) {
  let cachedRows: Record<string, unknown>[] | null = null;
  let inFlight: Promise<Record<string, unknown>[]> | null = null;

  async function prefetch(): Promise<Record<string, unknown>[]> {
    if (cachedRows !== null) {
      return cachedRows;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const res = await fetch(endpoint);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const data = (await res.json()) as { snapshots: LibraryUsageSnapshot[] };
        cachedRows = data.snapshots.flatMap((snapshot) =>
          snapshot.rows.map((row) => ({
            ...row,
            id: `${snapshot.weekOf}__${row.id}`,
            weekOf: snapshot.weekOf,
          })),
        );
        return cachedRows;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[x-studio] ${label} connector: could not reach ${endpoint} — is the API server ` +
            'running? (pnpm server)',
          err,
        );
        return [];
      }
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function createAdapter(): StudioDataSourceAdapter {
    return {
      async getRows() {
        return { rows: await prefetch() };
      },
    };
  }

  return { prefetch, createAdapter };
}

// ── Data grid libraries ─────────────────────────────────────────────────────

export const GITHUB_LIBRARY_USAGE_SOURCE_ID = 'source-github-library-usage';

export const GITHUB_LIBRARY_USAGE_SOURCE: StudioDataSource = {
  id: GITHUB_LIBRARY_USAGE_SOURCE_ID,
  label: 'GitHub Library Usage',
  fields: [
    { id: 'id', label: 'ID', type: 'string', hidden: true },
    { id: 'componentLibrary', label: 'Component Library', type: 'string' },
    { id: 'dataGridLibrary', label: 'Data Grid Library', type: 'string' },
    { id: 'repoCount', label: 'Repositories', type: 'number' },
  ],
};

const dataGridCurrent = createCurrentRowsConnector(
  '/api/github-library-usage',
  'GitHub library usage',
);
/** Fetches (and caches for the lifetime of the page) the latest data-grid adoption matrix. */
export const prefetchGithubLibraryUsage = dataGridCurrent.prefetch;
/** Returns a StudioDataSourceAdapter backed by the latest data-grid adoption matrix. */
export const createGithubLibraryUsageAdapter = dataGridCurrent.createAdapter;

export const GITHUB_LIBRARY_USAGE_HISTORY_SOURCE_ID = 'source-github-library-usage-history';

/**
 * Same shape as `GITHUB_LIBRARY_USAGE_SOURCE` plus a `weekOf` date field, so a
 * date-slider filter widget on this source can scrub through the captured
 * weekly snapshots — see server/index.ts's GET /api/github-library-usage/history
 * and server/snapshotStore.ts for how those snapshots are captured and stored.
 */
export const GITHUB_LIBRARY_USAGE_HISTORY_SOURCE: StudioDataSource = {
  id: GITHUB_LIBRARY_USAGE_HISTORY_SOURCE_ID,
  label: 'GitHub Library Usage (History)',
  fields: [
    { id: 'id', label: 'ID', type: 'string', hidden: true },
    { id: 'componentLibrary', label: 'Component Library', type: 'string' },
    { id: 'dataGridLibrary', label: 'Data Grid Library', type: 'string' },
    { id: 'repoCount', label: 'Repositories', type: 'number' },
    { id: 'weekOf', label: 'Week', type: 'date' },
  ],
};

const dataGridHistory = createHistoryRowsConnector(
  '/api/github-library-usage/history',
  'GitHub library usage history',
);
export const prefetchGithubLibraryUsageHistory = dataGridHistory.prefetch;
export const createGithubLibraryUsageHistoryAdapter = dataGridHistory.createAdapter;

// ── Chart libraries ──────────────────────────────────────────────────────────

export const GITHUB_CHART_LIBRARY_USAGE_SOURCE_ID = 'source-github-chart-library-usage';

export const GITHUB_CHART_LIBRARY_USAGE_SOURCE: StudioDataSource = {
  id: GITHUB_CHART_LIBRARY_USAGE_SOURCE_ID,
  label: 'GitHub Chart Library Usage',
  fields: [
    { id: 'id', label: 'ID', type: 'string', hidden: true },
    { id: 'componentLibrary', label: 'Component Library', type: 'string' },
    { id: 'chartLibrary', label: 'Chart Library', type: 'string' },
    { id: 'repoCount', label: 'Repositories', type: 'number' },
  ],
};

const chartLibraryCurrent = createCurrentRowsConnector(
  '/api/chart-library-usage',
  'GitHub chart library usage',
);
/** Fetches (and caches for the lifetime of the page) the latest chart-library adoption matrix. */
export const prefetchGithubChartLibraryUsage = chartLibraryCurrent.prefetch;
/** Returns a StudioDataSourceAdapter backed by the latest chart-library adoption matrix. */
export const createGithubChartLibraryUsageAdapter = chartLibraryCurrent.createAdapter;
