import type { StudioDateRangePreset } from '../models';

/** Computes start/end ISO date strings for a given date range preset. */
export function computeDateRangePreset(preset: Exclude<StudioDateRangePreset, 'custom'>): {
  from: string;
  to: string;
} {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = toISO(now);

  switch (preset) {
    case 'this_month': {
      const from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const to = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`;
      return { from, to };
    }
    case 'last_3_months': {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 3);
      return { from: toISO(d), to: today };
    }
    case 'last_12_months': {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - 1);
      return { from: toISO(d), to: today };
    }
    case 'ytd':
      return { from: `${now.getFullYear()}-01-01`, to: today };
    default:
      return { from: today, to: today };
  }
}
