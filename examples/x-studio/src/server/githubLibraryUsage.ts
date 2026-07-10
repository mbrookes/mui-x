/**
 * Server-side GitHub code-search matrix builders.
 *
 * Runs one GitHub code search per (component library, X library) pair to
 * count repos whose package.json declares both, e.g.:
 *
 *   "@mui/material" "@mui/x-data-grid" filename:package.json
 *
 * No `fork:` qualifier is needed — GitHub's code search already excludes
 * forks by default (`fork:true` is the only documented value, used to
 * *include* forks; there's no supported `fork:false`). An earlier version
 * of this query added `fork:false` explicitly and got a 422 from the API
 * for it — forks are excluded either way, so it was both redundant and
 * broken.
 *
 * This lives on the server (not the client) because GitHub code search
 * requires an authenticated request, and a personal access token must never
 * ship inside a client bundle — anyone loading the page could extract it.
 * See `server/index.ts` for the weekly-capture endpoints that serve this
 * data, and `connectors/githubLibraryUsageSource.ts` for the client
 * adapters that read it.
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
  // The unified `radix-ui` package (their All-in-One release) is the current recommended
  // install, so it's the cleanest single-package search term here — but many existing repos
  // still depend on individual `@radix-ui/react-*` primitive packages instead, which this
  // query won't match. Treat Radix's numbers as an undercount relative to the others.
  { id: 'radix-ui', label: 'Radix UI', pkg: 'radix-ui' },
  { id: 'base-ui', label: 'Base UI', pkg: '@base-ui/react' },
];

export const DATA_GRID_LIBRARIES: LibraryDef[] = [
  { id: 'mui-x-data-grid', label: 'MUI X Data Grid', pkg: '@mui/x-data-grid' },
  { id: 'ag-grid-react', label: 'AG Grid', pkg: 'ag-grid-react' },
  { id: 'tanstack-react-table', label: 'TanStack Table', pkg: '@tanstack/react-table' },
  { id: 'react-data-grid', label: 'React Data Grid', pkg: 'react-data-grid' },
];

export const CHART_LIBRARIES: LibraryDef[] = [
  { id: 'mui-x-charts', label: 'MUI X Charts', pkg: '@mui/x-charts' },
  { id: 'recharts', label: 'Recharts', pkg: 'recharts' },
  // The React wrapper, not the framework-agnostic `chart.js` core — consistent with how the
  // other libraries here are all searched by their React-facing package (e.g. `ag-grid-react`
  // rather than `ag-grid-community`), since this whole matrix is about React app choices.
  { id: 'chart-js', label: 'Chart.js', pkg: 'react-chartjs-2' },
  { id: 'victory', label: 'Victory', pkg: 'victory' },
];

const GITHUB_SEARCH_ENDPOINT = 'https://api.github.com/search/code';
// Stay comfortably under GitHub's 30 requests/min authenticated search limit. This alone isn't
// airtight — the 30/min budget is shared across the whole token, so a run that immediately
// follows a previous one (e.g. two redeploys in quick succession, each re-running a full matrix
// on a cold cache) can still exhaust it — see the retry-on-403 handling below, which is the
// actual backstop.
const REQUEST_INTERVAL_MS = 2500;
// Cap retries so a persistently-failing token/query doesn't hang the request forever.
const MAX_RATE_LIMIT_RETRIES = 3;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Counts (non-fork, by GitHub's default) repos whose package.json mentions both `pkgA` and `pkgB`. */
async function fetchCombinationCount(pkgA: string, pkgB: string, token: string): Promise<number> {
  const query = `"${pkgA}" "${pkgB}" filename:package.json`;
  const url = `${GITHUB_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&per_page=1`;

  for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
      },
    });
    if (res.ok) {
      // eslint-disable-next-line no-await-in-loop
      const data = (await res.json()) as { total_count: number };
      return data.total_count;
    }

    // GitHub's rate-limited response is a 403 with X-RateLimit-Remaining: 0 — distinct from an
    // auth/permissions 403 (bad or under-scoped token), which doesn't carry that header. Wait
    // for the window to actually reset and retry rather than recording a false 0 for this cell,
    // which would otherwise sit wrong in the persisted snapshot until the next weekly refresh.
    const isRateLimited = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0';
    if (isRateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
      const resetHeader = res.headers.get('x-ratelimit-reset');
      const resetAtMs = resetHeader ? Number(resetHeader) * 1000 : Date.now() + 60_000;
      const waitMs = Math.max(resetAtMs - Date.now(), 0) + 1000;
      warn(
        `[github-library-usage] rate limited for "${pkgA}" + "${pkgB}" — waiting ` +
          `${Math.round(waitMs / 1000)}s for the search quota to reset (attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES})`,
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(waitMs);
      continue;
    }

    // Include the response body — GitHub's error payload (e.g. a 422 validation message
    // naming a bad qualifier, or the rate-limit message once retries are exhausted) is the
    // only way to diagnose failures that a bare status code doesn't explain.
    // eslint-disable-next-line no-await-in-loop
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub search failed for "${pkgA}" + "${pkgB}": HTTP ${res.status} ${body}`);
  }
  /* istanbul ignore next -- unreachable: the loop above always returns or throws */
  throw new Error(`GitHub search failed for "${pkgA}" + "${pkgB}": exhausted retries`);
}

export interface LibraryUsageMatrixResult {
  rows: Record<string, unknown>[];
  /**
   * How many cells fell back to `repoCount: 0` because their search request
   * failed (as opposed to genuinely returning zero results). Callers that
   * persist this data (see server/index.ts's weekly capture) should treat a
   * fully-failed run (`failedCount === rows.length`) as no data at all —
   * without this, a bad/rate-limited token still produces a full set of rows
   * (all zero) rather than an empty array, so a naive `rows.length === 0`
   * check does NOT catch "every cell failed".
   */
  failedCount: number;
}

/**
 * Builds a component-library × `otherLibraries` adoption matrix, one GitHub
 * code search per cell, storing each row's second-axis label under
 * `otherFieldKey` (e.g. 'dataGridLibrary' or 'chartLibrary') so callers get
 * differently-shaped rows from the same fetch logic. Returns
 * { rows: [], failedCount: 0 } (without throwing) when no token is
 * configured. Individual failed cells fall back to a count of 0 rather than
 * aborting the whole matrix — see `LibraryUsageMatrixResult.failedCount` for
 * how to tell a real zero from a failure once every cell is done.
 */
async function fetchLibraryUsageMatrixFor(
  otherLibraries: LibraryDef[],
  otherFieldKey: string,
  token: string | undefined,
  label: string,
): Promise<LibraryUsageMatrixResult> {
  if (!token) {
    warn(
      `[${label}] no GITHUB_SEARCH_TOKEN configured — returning an empty matrix. ` +
        'GitHub code search requires authentication.',
    );
    return { rows: [], failedCount: 0 };
  }

  const rows: Record<string, unknown>[] = [];
  let failedCount = 0;
  let isFirstRequest = true;
  for (const componentLib of COMPONENT_LIBRARIES) {
    for (const otherLib of otherLibraries) {
      if (!isFirstRequest) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(REQUEST_INTERVAL_MS);
      }
      isFirstRequest = false;
      let repoCount = 0;
      try {
        // eslint-disable-next-line no-await-in-loop
        repoCount = await fetchCombinationCount(componentLib.pkg, otherLib.pkg, token);
      } catch (err) {
        failedCount += 1;
        warn(`[${label}]`, err);
      }
      rows.push({
        id: `${componentLib.id}__${otherLib.id}`,
        componentLibrary: componentLib.label,
        [otherFieldKey]: otherLib.label,
        repoCount,
      });
    }
  }
  return { rows, failedCount };
}

/** Component-library × data-grid-library adoption matrix (see fetchLibraryUsageMatrixFor). */
export function fetchLibraryUsageMatrix(
  token: string | undefined,
): Promise<LibraryUsageMatrixResult> {
  return fetchLibraryUsageMatrixFor(
    DATA_GRID_LIBRARIES,
    'dataGridLibrary',
    token,
    'github-library-usage',
  );
}

/** Component-library × chart-library adoption matrix (see fetchLibraryUsageMatrixFor). */
export function fetchChartLibraryUsageMatrix(
  token: string | undefined,
): Promise<LibraryUsageMatrixResult> {
  return fetchLibraryUsageMatrixFor(
    CHART_LIBRARIES,
    'chartLibrary',
    token,
    'github-chart-library-usage',
  );
}
