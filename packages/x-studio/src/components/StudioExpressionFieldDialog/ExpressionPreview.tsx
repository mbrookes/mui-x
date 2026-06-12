'use client';
import * as React from 'react';
import { Box, Chip, Stack, Typography } from '@mui/material';
import type {
  StudioDataSource,
  StudioExpression,
  StudioExpressionField,
} from '../../models';
import {
  evaluateExpression,
  evaluateMeasure,
} from '../../utils/expressionEvaluator';
import { formatNumber } from '../../internals/numberFormat';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

// ─── Preview ──────────────────────────────────────────────────────────────────

export interface ExpressionPreviewProps {
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
    const rows = dataSource.rows ?? [];
    const otherExprFields = expressionFields.filter((ef) => ef.id !== currentFieldId);
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
      <Box sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          {localeText.expressionPreviewMeasureLabel(previewResult.count)}
        </Typography>
        <Chip
          label={formatNumber(previewResult.value, undefined, undefined, undefined, precision)}
          size="small"
          color="primary"
          variant="outlined"
        />
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        {localeText.expressionPreviewFirstRowsLabel(previewResult.count)}
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
        {previewResult.values.map((v, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key, react-doctor/no-array-index-key -- preview values are positional display only
          <Chip
            key={`preview-${i}`}
            label={
              v == null
                ? 'null'
                : typeof v === 'number'
                  ? formatNumber(v, undefined, undefined, undefined, precision)
                  : String(v)
            }
            size="small"
            color="default"
            variant="outlined"
          />
        ))}
      </Stack>
    </Box>
  );
}

