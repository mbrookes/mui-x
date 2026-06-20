/**
 * Connector for the server-side-data example server.
 *
 * The server-side-data example ships its own standalone Express server that
 * exposes GET /api/employees.  This connector wraps it as a StudioDataSource
 * so its employee records appear as a first-class data source in x-studio.
 *
 * The adapter fetches all rows once and caches them in memory.  x-studio's
 * client-side pipeline (L3) handles filtering, grouping, and aggregation so
 * the adapter itself stays trivial.
 *
 * Setup:
 *   cd examples/server-side-data/server && PORT=3002 pnpm dev
 *   Set VITE_EMPLOYEES_SERVER_URL=http://localhost:3002 in .env.local
 */
import type { StudioDataSource, StudioDataSourceAdapter } from '@mui/x-studio';

export const EMPLOYEES_SOURCE_ID = 'source-employees';

export const EMPLOYEES_SOURCE: StudioDataSource = {
  id: EMPLOYEES_SOURCE_ID,
  label: 'Employees',
  fields: [
    { id: 'id', label: 'Employee ID', type: 'number', hidden: true },
    { id: 'name', label: 'Name', type: 'string' },
    { id: 'email', label: 'Email', type: 'string' },
    { id: 'role', label: 'Role', type: 'string' },
    { id: 'department', label: 'Department', type: 'string' },
    { id: 'salary', label: 'Salary', type: 'number', format: 'currency' },
    { id: 'startDate', label: 'Start Date', type: 'date' },
  ],
};

let cachedRows: Record<string, unknown>[] | null = null;

/**
 * Eagerly fetches all employee rows from the server-side-data server and
 * caches them in module scope.  Returns [] without throwing if the server is
 * not reachable.  Safe to call multiple times — returns the cached result after
 * the first successful fetch.
 */
export async function prefetchEmployees(
  serverUrl: string,
): Promise<Record<string, unknown>[]> {
  if (cachedRows !== null) {
    return cachedRows;
  }
  try {
    const res = await fetch(`${serverUrl}/api/employees?pageSize=1000`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { data: Record<string, unknown>[] };
    cachedRows = data.data;
    return cachedRows;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[x-studio] Employees connector: could not reach ${serverUrl} — ` +
        'is the server-side-data server running? (PORT=3002 pnpm dev)',
      err,
    );
    return [];
  }
}

/**
 * Returns a StudioDataSourceAdapter that fetches from the server-side-data
 * REST API and caches the result.  Returns empty rows (no crash) when the
 * server is not reachable — retries on the next getRows call.
 */
export function createEmployeesAdapter(serverUrl: string): StudioDataSourceAdapter {
  return {
    async getRows() {
      return { rows: await prefetchEmployees(serverUrl) };
    },
  };
}
