/**
 * Server-side GitHub code-search matrix builder.
 *
 * Runs one GitHub code search per (component library, data grid library)
 * pair to count non-fork repos whose package.json declares both, e.g.:
 *
 *   "@mui/material" "@mui/x-data-grid" filename:package.json fork:false
 *
 * This lives on the server (not the client) because GitHub code search
 * requires an authenticated request, and a personal access token must never
 * ship inside a client bundle — anyone loading the page could extract it.
 * See `server/index.ts` for the endpoint that serves this data and caches it
 * in memory, and `connectors/githubLibraryUsageSource.ts` for the client
 * adapter that reads it.
 */
import { warn } from './logger.js';

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

const GITHUB_SEARCH_ENDPOINT = 'https://api.github.com/search/code';
// Stay comfortably under GitHub's 30 requests/min authenticated search limit.
const REQUEST_INTERVAL_MS = 2100;

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
 * GitHub code search per cell. Returns [] (without throwing) when no token
 * is configured. Individual failed cells fall back to a count of 0 rather
 * than aborting the whole matrix.
 */
export async function fetchLibraryUsageMatrix(
  token: string | undefined,
): Promise<Record<string, unknown>[]> {
  if (!token) {
    warn(
      '[github-library-usage] no GITHUB_SEARCH_TOKEN configured — returning an empty matrix. ' +
        'GitHub code search requires authentication.',
    );
    return [];
  }

  const rows: Record<string, unknown>[] = [];
  let isFirstRequest = true;
  for (const componentLib of COMPONENT_LIBRARIES) {
    for (const gridLib of DATA_GRID_LIBRARIES) {
      if (!isFirstRequest) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(REQUEST_INTERVAL_MS);
      }
      isFirstRequest = false;
      let repoCount = 0;
      try {
        // eslint-disable-next-line no-await-in-loop
        repoCount = await fetchCombinationCount(componentLib.pkg, gridLib.pkg, token);
      } catch (err) {
        warn('[github-library-usage]', err);
      }
      rows.push({
        id: `${componentLib.id}__${gridLib.id}`,
        componentLibrary: componentLib.label,
        dataGridLibrary: gridLib.label,
        repoCount,
      });
    }
  }
  return rows;
}
