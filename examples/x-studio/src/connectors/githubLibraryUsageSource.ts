/**
 * Connector that builds a "component library × data grid library" adoption
 * matrix from the GitHub code-search API.
 *
 * For every (component library, data grid library) pair, it runs one GitHub
 * code search for `package.json` files that mention both package names, e.g.:
 *
 *   "@mui/material" "@mui/x-data-grid" filename:package.json fork:false
 *
 * `fork:false` restricts results to source repositories (forks excluded), as
 * required. The `total_count` from each search becomes one heatmap cell.
 *
 * GitHub's code-search endpoint requires an authenticated request and is
 * heavily rate-limited, so results are cached in localStorage for a day and
 * requests are spaced out to stay under the search rate limit.
 *
 * Setup: create a personal access token (no scopes needed for public code
 * search) and set VITE_GITHUB_TOKEN in .env.local.
 */
import type { StudioDataSource, StudioDataSourceAdapter } from '@mui/x-studio';

export const GITHUB_LIBRARY_USAGE_SOURCE_ID = 'source-github-library-usage';

interface LibraryDef {
  id: string;
  label: string;
  /** npm package name searched for as a quoted phrase in package.json. */
  pkg: string;
}

export const COMPONENT_LIBRARIES: LibraryDef[] = [
  { id: 'mui-material', label: 'MUI Material', pkg: '@mui/material' },
  { id: 'antd', label: 'Ant Design', pkg: 'antd' },
  { id: 'chakra-ui', label: 'Chakra UI', pkg: '@chakra-ui/react' },
  { id: 'react-bootstrap', label: 'React Bootstrap', pkg: 'react-bootstrap' },
];

export const DATA_GRID_LIBRARIES: LibraryDef[] = [
  { id: 'mui-x-data-grid', label: 'MUI X Data Grid', pkg: '@mui/x-data-grid' },
  { id: 'ag-grid-react', label: 'AG Grid', pkg: 'ag-grid-react' },
  { id: 'tanstack-react-table', label: 'TanStack Table', pkg: '@tanstack/react-table' },
  { id: 'react-data-grid', label: 'React Data Grid', pkg: 'react-data-grid' },
];

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

const GITHUB_SEARCH_ENDPOINT = 'https://api.github.com/search/code';
const CACHE_KEY = 'x-studio:github-library-usage-cache:v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Stay comfortably under GitHub's 30 requests/min authenticated search limit.
const REQUEST_INTERVAL_MS = 2100;

let cachedRows: Record<string, unknown>[] | null = null;
let inFlight: Promise<Record<string, unknown>[]> | null = null;

interface CacheEnvelope {
  rows: Record<string, unknown>[];
  fetchedAt: number;
}

function readCache(): Record<string, unknown>[] | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) {
      return null;
    }
    return parsed.rows;
  } catch {
    return null;
  }
}

function writeCache(rows: Record<string, unknown>[]) {
  try {
    const envelope: CacheEnvelope = { rows, fetchedAt: Date.now() };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // Storage full or unavailable (e.g. private browsing) — skip caching.
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Counts non-fork repos whose package.json mentions both `pkgA` and `pkgB`. */
async function fetchCombinationCount(pkgA: string, pkgB: string, token: string): Promise<number> {
  const query = `"${pkgA}" "${pkgB}" filename:package.json fork:false`;
  const url = `${GITHUB_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&per_page=1`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub search failed for "${pkgA}" + "${pkgB}": HTTP ${res.status}`);
  }
  const data = (await res.json()) as { total_count: number };
  return data.total_count;
}

/**
 * Builds the component-library × data-grid-library adoption matrix, one
 * GitHub code search per cell. Returns [] (without throwing) when no token is
 * configured or a request fails — the caller decides how to surface that.
 */
export async function prefetchGithubLibraryUsage(
  token: string | undefined,
): Promise<Record<string, unknown>[]> {
  if (cachedRows !== null) {
    return cachedRows;
  }
  const cached = readCache();
  if (cached) {
    cachedRows = cached;
    return cached;
  }
  if (inFlight) {
    return inFlight;
  }
  if (!token) {
    // eslint-disable-next-line no-console
    console.warn(
      '[x-studio] GitHub library usage connector: no token configured — set ' +
        'VITE_GITHUB_TOKEN in .env.local. GitHub code search requires authentication.',
    );
    return [];
  }

  inFlight = (async () => {
    const rows: Record<string, unknown>[] = [];
    let isFirstRequest = true;
    for (const componentLib of COMPONENT_LIBRARIES) {
      for (const gridLib of DATA_GRID_LIBRARIES) {
        if (!isFirstRequest) {
          await sleep(REQUEST_INTERVAL_MS);
        }
        isFirstRequest = false;
        let repoCount = 0;
        try {
          repoCount = await fetchCombinationCount(componentLib.pkg, gridLib.pkg, token);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[x-studio] GitHub library usage connector:', err);
        }
        rows.push({
          id: `${componentLib.id}__${gridLib.id}`,
          componentLibrary: componentLib.label,
          dataGridLibrary: gridLib.label,
          repoCount,
        });
      }
    }
    cachedRows = rows;
    writeCache(rows);
    return rows;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Returns a StudioDataSourceAdapter backed by the GitHub search matrix above. */
export function createGithubLibraryUsageAdapter(
  token: string | undefined,
): StudioDataSourceAdapter {
  return {
    async getRows() {
      return { rows: await prefetchGithubLibraryUsage(token) };
    },
  };
}
