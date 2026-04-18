import type { StudioFilterState } from '../models';

type Row = Record<string, unknown>;

function matchesFilter(row: Row, filter: StudioFilterState): boolean {
  const rowVal = row[filter.field];
  const filterVal = filter.value;

  switch (filter.operator) {
    case 'equals':
      // eslint-disable-next-line eqeqeq
      return rowVal == filterVal;
    case 'not_equals':
      // eslint-disable-next-line eqeqeq
      return rowVal != filterVal;
    case 'contains':
      return String(rowVal ?? '').toLowerCase().includes(String(filterVal ?? '').toLowerCase());
    case 'greater_than':
      return Number(rowVal) > Number(filterVal);
    case 'less_than':
      return Number(rowVal) < Number(filterVal);
    case 'greater_than_or_equal':
      return Number(rowVal) >= Number(filterVal);
    case 'less_than_or_equal':
      return Number(rowVal) <= Number(filterVal);
    default:
      return true;
  }
}

export function applyFilters(rows: Row[], filters: StudioFilterState[]): Row[] {
  if (filters.length === 0) {
    return rows;
  }

  return rows.filter((row) => filters.every((f) => matchesFilter(row, f)));
}

export interface AggregatedData {
  labels: (string | number)[];
  values: number[];
}

export function aggregateByField(rows: Row[], xField: string, yField: string): AggregatedData {
  const grouped = new Map<string | number, number>();

  for (const row of rows) {
    const xVal = row[xField] as string | number;
    const yVal = Number(row[yField] ?? 0);
    const key = xVal ?? '(empty)';

    grouped.set(key, (grouped.get(key) ?? 0) + yVal);
  }

  const labels = Array.from(grouped.keys());
  const values = labels.map((label) => grouped.get(label) ?? 0);

  return { labels, values };
}
