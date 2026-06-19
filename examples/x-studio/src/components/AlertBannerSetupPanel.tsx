import {
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectDataSources,
  selectExpressionFields,
} from '@mui/x-studio';
import type { StudioCustomWidgetSetupPanelProps } from '@mui/x-studio';
import { useAppLocaleText } from '../locales/AppLocaleContext';
import {
  computeBannerValue,
  resolveBannerSeverity,
  type AlertBannerConfig,
  type Aggregation,
  type HideBelow,
  type Severity,
} from './AlertBannerWidget';

/**
 * Compose-drawer setup panel for the Alert Banner custom widget.
 *
 * Edits the banner's `customConfig`: the message, the value field + aggregation
 * that drives severity, the date field + look-back window that scopes the value
 * to a time range, the severity thresholds, and the view-mode display condition.
 */
export function AlertBannerSetupPanel({ widgetId }: StudioCustomWidgetSetupPanelProps) {
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const dataSources = useStudioSelector(selectDataSources);
  const allExpressionFields = useStudioSelector(selectExpressionFields);
  const t = useAppLocaleText();

  if (!widget) {
    return null;
  }

  const source = widget.sourceId ? dataSources[widget.sourceId] : undefined;
  const sourceId = widget.sourceId;

  // Include expression fields alongside physical fields so computed columns
  // (e.g. expr-order-total-usd) appear in the value and date field selectors.
  const exprForSource = allExpressionFields.filter((ef) => ef.sourceId === sourceId && !ef.hidden);
  const numberFields: { id: string; label: string }[] = [
    ...(source?.fields.filter((f) => !f.hidden && f.type === 'number') ?? []),
    ...exprForSource
      .filter((ef) => ef.type === 'number' || ef.type == null)
      .map((ef) => ({ id: ef.id, label: ef.label })),
  ];
  const dateFields: { id: string; label: string }[] = [
    ...(source?.fields.filter((f) => !f.hidden && (f.type === 'date' || f.type === 'datetime')) ??
      []),
    ...exprForSource
      .filter((ef) => ef.type === 'date' || ef.type === 'datetime')
      .map((ef) => ({ id: ef.id, label: ef.label })),
  ];

  const custom = (widget.config.customConfig ?? {}) as AlertBannerConfig;
  const message = custom.message ?? '';
  const valueField = custom.valueField ?? '';
  const aggregation = custom.aggregation ?? 'sum';
  const dateField = custom.dateField ?? '';
  const lookbackDays = custom.lookbackDays ?? 0;
  const hideBelow: HideBelow = custom.hideBelow ?? 'never';

  function updateCustomConfig(changes: Partial<AlertBannerConfig>) {
    controller.updateWidgetConfig(widgetId, {
      customConfig: { ...custom, ...changes },
    });
  }

  // Live preview of the computed value + resolved severity so the user can tune
  // thresholds against the actual data.
  const previewValue = computeBannerValue(custom, source);
  const previewSeverity: Severity = resolveBannerSeverity(previewValue, custom);
  const previewLabel =
    previewValue == null
      ? '—'
      : previewValue.toLocaleString(undefined, { maximumFractionDigits: 2 });

  const aggregationOptions: { value: Aggregation; label: string }[] = [
    { value: 'sum', label: t.alertAggSum },
    { value: 'avg', label: t.alertAggAvg },
    { value: 'max', label: t.alertAggMax },
    { value: 'min', label: t.alertAggMin },
    { value: 'count', label: t.alertAggCount },
  ];

  const hideOptions: { value: HideBelow; label: string }[] = [
    { value: 'never', label: t.alertHideNever },
    { value: 'warning', label: t.alertHideBelowWarning },
    { value: 'error', label: t.alertHideBelowError },
  ];

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2" color="text.secondary">
        {t.alertBannerSettingsTitle}
      </Typography>

      <TextField
        label={t.alertMessageLabel}
        value={message}
        onChange={(event) => updateCustomConfig({ message: event.target.value })}
        helperText={t.alertMessageHelper}
        size="small"
        fullWidth
        multiline
        rows={2}
      />

      <Divider flexItem />

      <FormControl size="small" fullWidth>
        <InputLabel>{t.alertValueFieldLabel}</InputLabel>
        <Select
          value={numberFields.some((f) => f.id === valueField) ? valueField : ''}
          label={t.alertValueFieldLabel}
          onChange={(event) => updateCustomConfig({ valueField: event.target.value })}
        >
          {numberFields.map((f) => (
            <MenuItem key={f.id} value={f.id}>
              {f.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>{t.alertAggregationLabel}</InputLabel>
        <Select
          value={aggregation}
          label={t.alertAggregationLabel}
          onChange={(event) =>
            updateCustomConfig({ aggregation: event.target.value as Aggregation })
          }
        >
          {aggregationOptions.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth>
        <InputLabel>{t.alertDateFieldLabel}</InputLabel>
        <Select
          value={dateFields.some((f) => f.id === dateField) ? dateField : ''}
          label={t.alertDateFieldLabel}
          onChange={(event) => updateCustomConfig({ dateField: event.target.value })}
        >
          <MenuItem value="">
            <em>{t.alertHideNever}</em>
          </MenuItem>
          {dateFields.map((f) => (
            <MenuItem key={f.id} value={f.id}>
              {f.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <TextField
        label={t.alertLookbackLabel}
        type="number"
        value={lookbackDays || ''}
        onChange={(event) => updateCustomConfig({ lookbackDays: Number(event.target.value) || 0 })}
        disabled={!dateField}
        size="small"
        fullWidth
      />

      <Divider flexItem />

      <Typography variant="subtitle2" color="text.secondary">
        {t.alertThresholdsTitle}
      </Typography>
      <TextField
        label={t.alertThresholdSuccess}
        type="number"
        value={custom.thresholdSuccess ?? ''}
        onChange={(event) =>
          updateCustomConfig({
            thresholdSuccess: event.target.value === '' ? undefined : Number(event.target.value),
          })
        }
        size="small"
        fullWidth
      />
      <TextField
        label={t.alertThresholdWarning}
        type="number"
        value={custom.thresholdWarning ?? ''}
        onChange={(event) =>
          updateCustomConfig({
            thresholdWarning: event.target.value === '' ? undefined : Number(event.target.value),
          })
        }
        size="small"
        fullWidth
      />
      <TextField
        label={t.alertThresholdError}
        type="number"
        value={custom.thresholdError ?? ''}
        onChange={(event) =>
          updateCustomConfig({
            thresholdError: event.target.value === '' ? undefined : Number(event.target.value),
          })
        }
        size="small"
        fullWidth
      />

      <Divider flexItem />

      <FormControl size="small" fullWidth>
        <InputLabel>{t.alertHideBelowLabel}</InputLabel>
        <Select
          value={hideBelow}
          label={t.alertHideBelowLabel}
          onChange={(event) => updateCustomConfig({ hideBelow: event.target.value as HideBelow })}
        >
          {hideOptions.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      {hideBelow !== 'never' && (
        <Typography variant="caption" color="text.secondary">
          {t.alertHiddenInViewNote}
        </Typography>
      )}

      <Divider flexItem />

      <Typography variant="caption" color={`${previewSeverity}.main`}>
        {t.alertComputedLabel(previewLabel, lookbackDays || 0)}
      </Typography>
    </Stack>
  );
}
