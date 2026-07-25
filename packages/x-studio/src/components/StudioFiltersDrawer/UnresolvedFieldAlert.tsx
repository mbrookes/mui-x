'use client';
import * as React from 'react';
import { Alert, Button } from '@mui/material';
import { useStudioLocaleText } from '../../context';

/**
 * Banner shown inside a filter row whose stored field no longer names a real column.
 *
 * A filter on a missing field is not inert: the engine reads `undefined` for every row, so
 * the widget renders empty while the row itself looks perfectly normal. This banner is the
 * only thing that distinguishes "the filter excluded everything" from "there is no data".
 *
 * Invariant: callers render it only for `resolveFilterField(...) === 'unresolved'`, never for
 * `'unknown'`, so a data-load race is never reported as a broken filter.
 *
 * `onRepoint` clears the field, dropping the row back to its field picker; removal is already
 * offered by the surrounding card/row.
 */
export function UnresolvedFieldAlert(props: { fieldId: string; onRepoint?: () => void }) {
  const { fieldId, onRepoint } = props;
  const localeText = useStudioLocaleText();

  return (
    <Alert
      severity="warning"
      data-testid="filter-field-unresolved"
      action={
        onRepoint ? (
          <Button color="inherit" size="small" onClick={onRepoint}>
            {localeText.filterSelectField}
          </Button>
        ) : undefined
      }
    >
      {localeText.dataSourceFieldUnavailableHelperText(fieldId)}
    </Alert>
  );
}
