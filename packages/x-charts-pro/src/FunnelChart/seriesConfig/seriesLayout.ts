import type { SeriesLayoutGetter } from '@mui/x-charts/internals';

const seriesLayout: SeriesLayoutGetter<'funnel'> = (series) => {
  const result: Record<string, { gap: number }> = {};

  series.seriesOrder.forEach((id) => {
    result[id] = { gap: series.series[id].gap };
  });

  return result;
};

export default seriesLayout;
