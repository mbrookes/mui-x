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
    case 'this_calendar_year': {
      const year = now.getFullYear();
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    case 'last_calendar_year': {
      const year = now.getFullYear() - 1;
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    case 'last_2_calendar_years': {
      const lastYear = now.getFullYear() - 1;
      const twoYearsAgo = now.getFullYear() - 2;
      return { from: `${twoYearsAgo}-01-01`, to: `${lastYear}-12-31` };
    }
    case 'this_quarter': {
      const year = now.getFullYear();
      const qStart = Math.floor(now.getMonth() / 3) * 3;
      const qEnd = qStart + 2;
      const lastDay = new Date(year, qEnd + 1, 0).getDate();
      return {
        from: `${year}-${pad(qStart + 1)}-01`,
        to: `${year}-${pad(qEnd + 1)}-${pad(lastDay)}`,
      };
    }
    case 'last_quarter': {
      let year = now.getFullYear();
      let qStart = Math.floor(now.getMonth() / 3) * 3 - 3;
      if (qStart < 0) {
        qStart += 12;
        year -= 1;
      }
      const qEnd = qStart + 2;
      const lastDay = new Date(year, qEnd + 1, 0).getDate();
      return {
        from: `${year}-${pad(qStart + 1)}-01`,
        to: `${year}-${pad(qEnd + 1)}-${pad(lastDay)}`,
      };
    }
    case 'this_and_last_quarter': {
      const year = now.getFullYear();
      const thisQStart = Math.floor(now.getMonth() / 3) * 3;
      const thisQEnd = thisQStart + 2;
      let lastQStart = thisQStart - 3;
      let lastQYear = year;
      if (lastQStart < 0) {
        lastQStart += 12;
        lastQYear -= 1;
      }
      const thisQLastDay = new Date(year, thisQEnd + 1, 0).getDate();
      return {
        from: `${lastQYear}-${pad(lastQStart + 1)}-01`,
        to: `${year}-${pad(thisQEnd + 1)}-${pad(thisQLastDay)}`,
      };
    }
    default: {
      const exhaustive: never = preset;
      void exhaustive;
      return { from: today, to: today };
    }
  }
}
