import type { StudioDataField, StudioNumberFormat } from '../models/studio';

export function formatNumber(
  value: number,
  format?: StudioNumberFormat,
  currencyCode?: string,
  compact?: boolean,
): string {
  const notation: Intl.NumberFormatOptions['notation'] = compact ? 'compact' : 'standard';
  const compactDisplay: Intl.NumberFormatOptions['compactDisplay'] = 'short';

  switch (format) {
    case 'integer':
      return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: compact ? 1 : 0,
        notation,
        compactDisplay,
      }).format(value);
    case 'decimal':
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: compact ? 0 : 2,
        maximumFractionDigits: compact ? 1 : 2,
        notation,
        compactDisplay,
      }).format(value);
    case 'percent':
      return new Intl.NumberFormat(undefined, {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(value / 100);
    case 'currency':
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode ?? 'USD',
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: compact ? 1 : 0,
        notation,
        compactDisplay,
      }).format(value);
    default:
      return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: compact ? 1 : 2,
        notation,
        compactDisplay,
      }).format(value);
  }
}

export function formatFieldValue(
  value: unknown,
  field?: Pick<StudioDataField, 'type' | 'format' | 'currencyCode'>,
): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (field?.type === 'number' && typeof value === 'number') {
    return formatNumber(value, field.format, field.currencyCode);
  }
  return String(value);
}
