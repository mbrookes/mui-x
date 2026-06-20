import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals/attribution';
import type { Metric } from 'web-vitals';

function handleMetric(metric: Metric) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.table({
      name: metric.name,
      value: `${metric.value.toFixed(1)}${metric.name === 'CLS' ? '' : 'ms'}`,
      rating: metric.rating,
      id: metric.id,
    });

    if (metric.name === 'INP') {
      const attr = (metric as Parameters<Parameters<typeof onINP>[0]>[0]).attribution;
      if (attr) {
        // eslint-disable-next-line no-console
        console.groupCollapsed(`[INP] ${metric.value.toFixed(0)}ms — ${attr.interactionTarget}`);
        // eslint-disable-next-line no-console
        console.table({
          inputDelay: `${attr.inputDelay?.toFixed(1)}ms`,
          processingDuration: `${attr.processingDuration?.toFixed(1)}ms`,
          presentationDelay: `${attr.presentationDelay?.toFixed(1)}ms`,
          interactionType: attr.interactionType,
          interactionTarget: attr.interactionTarget,
        });
        // eslint-disable-next-line no-console
        console.groupEnd();
      }
    }
  } else {
    navigator.sendBeacon?.(
      '/analytics/vitals',
      JSON.stringify({
        name: metric.name,
        id: metric.id,
        value: metric.value,
        delta: metric.delta,
        rating: metric.rating,
      }),
    );
  }
}

export function reportWebVitals() {
  onCLS(handleMetric);
  onFCP(handleMetric);
  onINP(handleMetric);
  onLCP(handleMetric);
  onTTFB(handleMetric);
}
