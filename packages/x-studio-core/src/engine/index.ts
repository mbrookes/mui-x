/**
 * The row pipeline and everything that computes over it: normalization and caches (L1–L4),
 * filter scoping, chart aggregation and shapes, query descriptors, expression enrichment,
 * formatting and localization.
 *
 * This is the largest surface in the package and the one a binding leans on most.
 */
export * from './StudioPipeline';
export * from './StudioRequestCache';
export * from './aggregate';
export * from './aggregators';
export * from './anomalyDetection';
export * from './chartAggregation';
export * from './chartSupport';
export * from './chartTypeRegistry';
export * from './chartValues';
export * from './computedCache';
export * from './countryUtils';
export * from './crossFilterValueLabel';
export * from './crossSourceEnrichment';
export * from './cssValueValidation';
export * from './csvUtils';
export * from './dataSourceGraph';
export * from './dataSourceRowState';
export * from './dateRangeUtils';
export * from './enrichedRowsCache';
export * from './executeLocalQuery';
export * from './expressionRefs';
export * from './fieldCatalog';
export * from './fieldSuggestions';
export * from './filterDrawerTypes';
export * from './filterDrawerUtils';
export * from './filterOperatorMetadata';
export * from './filterScoping';
export * from './filterTypes';
export * from './filterUtils';
export * from './forecastUtils';
export * from './geographyLoaders';
export * from './grainResolution';
export * from './joinKeys';
export * from './kpiUtils';
export * from './localeText';
export * from './normalizedRowsCache';
export * from './numberFormat';
export * from './queryDescriptor';
export * from './queryPlan';
export * from './rankFilterScope';
export * from './resolvedRowsCache';
export * from './rowCacheLru';
export * from './rowIdentity';
export * from './stableStringify';
export * from './studioLocale';
export * from './temporalUtils';
export * from './textFontFamily';
export * from './usePageChartColors';
export * from './widgetConfigSanitization';
export * from './widgetFactory';
export * from './widgetLayoutMove';
export * from './widgetPageResolution';
export * from './widgetUtils';
export * from './chartShapes/funnel';
export * from './chartShapes/gantt';
export * from './chartShapes/heatmap';
export * from './chartShapes/index';
export * from './chartShapes/sankey';
export * from './chartShapes/scatter';
