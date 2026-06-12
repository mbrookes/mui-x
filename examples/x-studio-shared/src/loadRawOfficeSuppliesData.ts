import { agStudioSeededFactory } from './prng.js';
import type { RawOfficeSuppliesData } from './types.js';

type StatsHint = { indexToValue?: unknown[]; nullCount?: number };

/**
 * Convert a single columnar source to an array of plain row objects.
 *
 * The AG Grid generator uses dictionary encoding for string columns: each
 * value is stored as a small integer index into `statsHints[colIndex].indexToValue`.
 * Boolean and numeric columns are stored as-is in typed or plain arrays.
 */
async function columnarToRows(source: {
  tables: Array<{ fields: Array<{ id: string }> }>;
  getData: (
    arg: null,
    fieldIds: string[],
  ) => Promise<{
    data: Array<ArrayLike<number> | boolean[]>;
    nullMasks?: Uint8Array[];
    statsHints?: Record<number, StatsHint>;
  }>;
}): Promise<Record<string, unknown>[]> {
  const fieldIds = source.tables[0].fields.map((f) => f.id);
  const { data, statsHints } = await source.getData(null, fieldIds);
  const rowCount = data[0]?.length ?? 0;

  return Array.from({ length: rowCount }, (_, i) => {
    const row: Record<string, unknown> = {};
    fieldIds.forEach((id, j) => {
      const hint = statsHints?.[j] as StatsHint | undefined;
      const raw = (data[j] as ArrayLike<unknown>)[i];
      if (hint?.indexToValue) {
        // Dictionary-encoded string — raw is an integer index
        const decoded = hint.indexToValue[raw as number];
        row[id] = decoded === 'undefined' ? null : (decoded ?? null);
      } else {
        row[id] = raw === undefined ? null : raw;
      }
    });
    return row;
  });
}

let cached: RawOfficeSuppliesData | null = null;

/**
 * Load the AG Grid "Office Supplies" demo dataset at runtime using the
 * vendored AG Grid generator bundle. The generator runs synchronously and
 * requires no network access. A seeded PRNG is injected so the output is
 * deterministic across page loads.
 *
 * The result is cached after the first call.
 */
export async function loadRawOfficeSuppliesData(): Promise<RawOfficeSuppliesData> {
  if (cached) {
    return cached;
  }

  // Dynamic import keeps the 46KB bundle out of the initial JS parse budget.
  const { getMainDemoDataGenerated } = await import('./vendor/mainDemoData.js');

  const result = getMainDemoDataGenerated(agStudioSeededFactory);
  const byId = Object.fromEntries(result.sources.map((s) => [s.id, s])) as unknown as Record<
    string,
    Parameters<typeof columnarToRows>[0]
  >;

  const [stores, products, customers, orders, orderItems, shipments] = await Promise.all([
    columnarToRows(byId.stores),
    columnarToRows(byId.products),
    columnarToRows(byId.customers),
    columnarToRows(byId.orders),
    columnarToRows(byId.order_items),
    columnarToRows(byId.shipments),
  ]);

  cached = {
    stores: stores as RawOfficeSuppliesData['stores'],
    products: products as RawOfficeSuppliesData['products'],
    customers: customers as RawOfficeSuppliesData['customers'],
    orders: orders as RawOfficeSuppliesData['orders'],
    orderItems: orderItems as RawOfficeSuppliesData['orderItems'],
    shipments: shipments as RawOfficeSuppliesData['shipments'],
  };

  return cached;
}
