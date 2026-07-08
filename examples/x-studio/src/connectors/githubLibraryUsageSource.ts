/**
 * Client connector for the "component library × data grid library" adoption
 * chart.
 *
 * Reads GET /api/github-library-usage from this app's own API server (see
 * src/server/index.ts + src/server/githubLibraryUsage.ts), which proxies
 * GitHub's code-search API using a server-side token. The GitHub token never
 * ships to the browser — baking a personal access token into the client
 * bundle via a VITE_ env var would expose it to anyone who loads the page.
 *
 * `/api/*` requests resolve relative to the current origin: in production a
 * single Railway service serves both the built client and this API (see
 * railway.toml), so no base URL is needed; in local dev, `vite.config.ts`
 * proxies `/api` to the separately-running `pnpm server` process.
 *
 * Without the API server running, or when it has no GITHUB_SEARCH_TOKEN configured,
 * the endpoint returns an empty row set and the chart shows its "no data"
 * state rather than erroring.
 */
import type { StudioDataSource, StudioDataSourceAdapter } from '@mui/x-studio';

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

let cachedRows: Record<string, unknown>[] | null = null;
let inFlight: Promise<Record<string, unknown>[]> | null = null;

/**
 * Fetches (and caches for the lifetime of the page) the adoption matrix from
 * this app's own API server. Returns [] (without throwing) on failure — the
 * caller decides how to surface that.
 */
export async function prefetchGithubLibraryUsage(): Promise<Record<string, unknown>[]> {
  if (cachedRows !== null) {
    return cachedRows;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const res = await fetch('/api/github-library-usage');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as { rows: Record<string, unknown>[] };
      cachedRows = data.rows;
      return cachedRows;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[x-studio] GitHub library usage connector: could not reach /api/github-library-usage — ' +
          'is the API server running? (pnpm server)',
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

/** Returns a StudioDataSourceAdapter backed by the GitHub search matrix above. */
export function createGithubLibraryUsageAdapter(): StudioDataSourceAdapter {
  return {
    async getRows() {
      return { rows: await prefetchGithubLibraryUsage() };
    },
  };
}

// ── Weekly history (scrubber) ───────────────────────────────────────────────

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

interface LibraryUsageSnapshot {
  weekOf: string;
  fetchedAt: number;
  rows: Record<string, unknown>[];
}

let cachedHistoryRows: Record<string, unknown>[] | null = null;
let historyInFlight: Promise<Record<string, unknown>[]> | null = null;

/**
 * Fetches every captured weekly snapshot and flattens them into one row set
 * with a `weekOf` on each row (row ids are prefixed with the week so they
 * stay unique across snapshots — the server's per-cell id alone repeats every
 * week). Returns [] (without throwing) on failure.
 */
export async function prefetchGithubLibraryUsageHistory(): Promise<Record<string, unknown>[]> {
  if (cachedHistoryRows !== null) {
    return cachedHistoryRows;
  }
  if (historyInFlight) {
    return historyInFlight;
  }

  historyInFlight = (async () => {
    try {
      const res = await fetch('/api/github-library-usage/history');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as { snapshots: LibraryUsageSnapshot[] };
      cachedHistoryRows = data.snapshots.flatMap((snapshot) =>
        snapshot.rows.map((row) => ({
          ...row,
          id: `${snapshot.weekOf}__${row.id}`,
          weekOf: snapshot.weekOf,
        })),
      );
      return cachedHistoryRows;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[x-studio] GitHub library usage history connector: could not reach ' +
          '/api/github-library-usage/history — is the API server running? (pnpm server)',
        err,
      );
      return [];
    }
  })();

  try {
    return await historyInFlight;
  } finally {
    historyInFlight = null;
  }
}

/** Returns a StudioDataSourceAdapter backed by the flattened weekly-history rows above. */
export function createGithubLibraryUsageHistoryAdapter(): StudioDataSourceAdapter {
  return {
    async getRows() {
      return { rows: await prefetchGithubLibraryUsageHistory() };
    },
  };
}
