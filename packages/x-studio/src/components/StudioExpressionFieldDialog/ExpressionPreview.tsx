'use client';
import * as React from 'react';
import { Box, Chip, Stack, Typography } from '@mui/material';
import type { StudioDataSource, StudioExpression, StudioExpressionField } from '../../models';
import { evaluateExpression, evaluateMeasure } from '../../utils/expressionEvaluator';
import { formatNumber } from '../../internals/numberFormat';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

// ─── Preview ──────────────────────────────────────────────────────────────────

interface ExpressionPreviewProps {
  expression: StudioExpression;
  isMeasure: boolean;
  dataSource: StudioDataSource;
  expressionFields: StudioExpressionField[];
  currentFieldId: string;
  precision?: number;
}

export function ExpressionPreview({
  expression,
  isMeasure,
  dataSource,
  expressionFields,
  currentFieldId,
  precision,
}: ExpressionPreviewProps) {
  const localeText = useStudioLocaleText();
  const previewResult = React.useMemo(() => {
    const rows = dataSource.rows;
    const otherExprFields = expressionFields.filter((ef) => ef.id !== currentFieldId);
    // H1: `dataSource.rows ?? []` fed an EMPTY row array to `evaluateMeasure`, which returns the
    // identity of the aggregation — `0` for a `sum` — and the dialog rendered that as a confident
    // "the total is 0" preview. `rows` is `undefined` for every adapter-backed source (rows are
    // resolved per-widget into `studioRequestCache`; only the host's imperative
    // `setDataSourceRows` writes them onto the source), so an author configuring a `sum` measure
    // against a live database was shown a fabricated zero as the answer. There is nothing to
    // preview against rows that were never delivered — render nothing rather than a number that
    // was never measured. A source that genuinely returned `[]` is the same situation for preview
    // purposes: `sum` over zero rows is not a measurement of anything the author can check.
    if (rows === undefined || rows.length === 0) {
      return null;
    }
    try {
      if (isMeasure) {
        const draftField: StudioExpressionField = {
          id: currentFieldId,
          label: 'Preview',
          sourceId: dataSource.id,
          isMeasure: true,
          expression,
        };
        const value = evaluateMeasure(draftField, rows, otherExprFields);
        return { kind: 'measure' as const, value, count: rows.length };
      }
      const previewRows = rows.slice(0, 5);
      if (previewRows.length === 0) {
        return null;
      }
      const values = previewRows.map((row) =>
        evaluateExpression(expression, { row, expressionFields: otherExprFields, allRows: rows }),
      );
      return { kind: 'column' as const, values, count: previewRows.length };
    } catch {
      return null;
    }
  }, [expression, isMeasure, currentFieldId, dataSource, expressionFields]);

  if (!previewResult) {
    return null;
  }

  if (previewResult.kind === 'measure') {
    return (
      <Box role="status" aria-live="polite" sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          {localeText.expressionPreviewMeasureLabel(previewResult.count)}
        </Typography>
        <Chip
          label={
            // A root-level divide/modulo-by-zero yields `null` — no
            // valid result to format, rather than a fabricated 0. Uses the same localized
            // "no value" label as the column-preview chips below, which had drifted to a
            // bare em dash here.
            previewResult.value === null
              ? localeText.exprPreviewNullLabel
              : formatNumber(previewResult.value, undefined, undefined, undefined, precision)
          }
          size="small"
          color="primary"
          variant="outlined"
        />
      </Box>
    );
  }

  return (
    <Box role="status" aria-live="polite" sx={{ mt: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        {localeText.expressionPreviewFirstRowsLabel(previewResult.count)}
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
        {previewResult.values.map((v, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key, react-doctor/no-array-index-key -- preview values are positional display only
          <Chip
            key={`preview-${i}`}
            label={(() => {
              if (v == null) {
                return localeText.exprPreviewNullLabel;
              }
              if (typeof v === 'number') {
                return formatNumber(v, undefined, undefined, undefined, precision);
              }
              return String(v);
            })()}
            size="small"
            color="default"
            variant="outlined"
          />
        ))}
      </Stack>
    </Box>
  );
}
