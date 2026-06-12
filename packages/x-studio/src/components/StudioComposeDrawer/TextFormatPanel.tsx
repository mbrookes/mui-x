'use client';
import FormatAlignLeftIcon from '@mui/icons-material/FormatAlignLeft';
import FormatAlignCenterIcon from '@mui/icons-material/FormatAlignCenter';
import FormatAlignRightIcon from '@mui/icons-material/FormatAlignRight';
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  useStudioLocaleText,
} from '../../context';
import { CollapsibleSection } from '../../internals/CollapsibleSection';
import type { StudioWidgetConfig } from '../../models';
import { ColorInput } from './ColorInput';

interface TextSectionFormatProps {
  label: string;
  fontFamily?: 'serif' | 'monospace';
  fontSize?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  onFontFamilyChange: (v: 'serif' | 'monospace' | undefined) => void;
  onFontSizeChange: (v: number | undefined) => void;
  onColorChange: (v: string | undefined) => void;
  onAlignChange: (v: 'left' | 'center' | 'right' | undefined) => void;
}

function TextSectionFormat(props: TextSectionFormatProps) {
  const {
    label,
    fontFamily,
    fontSize,
    color,
    align,
    onFontFamilyChange,
    onFontSizeChange,
    onColorChange,
    onAlignChange,
  } = props;
  const localeText = useStudioLocaleText();

  return (
    <CollapsibleSection title={label}>
      <Stack spacing={1.5} sx={{ pb: 1.5 }}>
        <FormControl size="small" fullWidth>
          <InputLabel>{localeText.textFormatFontFamilyLabel}</InputLabel>
          <Select
            label={localeText.textFormatFontFamilyLabel}
            value={fontFamily ?? ''}
            onChange={(event) => {
              const v = event.target.value as string;
              onFontFamilyChange(v === '' ? undefined : (v as 'serif' | 'monospace'));
            }}
          >
            <MenuItem value="">{localeText.textFormatDefaultFont}</MenuItem>
            <MenuItem value="serif">{localeText.textFormatSerifFont}</MenuItem>
            <MenuItem value="monospace">{localeText.textFormatMonospaceFont}</MenuItem>
          </Select>
        </FormControl>

        <FormControl size="small" fullWidth>
          <InputLabel>{localeText.textFormatFontSizeLabel}</InputLabel>
          <Select
            label={localeText.textFormatFontSizeLabel}
            value={fontSize ?? 0}
            onChange={(event) => {
              const v = Number(event.target.value);
              onFontSizeChange(v === 0 ? undefined : v);
            }}
          >
            <MenuItem value={0}>{localeText.textFormatDefaultSize}</MenuItem>
            <MenuItem value={12}>12 px</MenuItem>
            <MenuItem value={14}>14 px</MenuItem>
            <MenuItem value={16}>16 px</MenuItem>
            <MenuItem value={18}>18 px</MenuItem>
            <MenuItem value={20}>20 px</MenuItem>
            <MenuItem value={24}>24 px</MenuItem>
            <MenuItem value={32}>32 px</MenuItem>
            <MenuItem value={40}>40 px</MenuItem>
          </Select>
        </FormControl>

        <ColorInput
          label={localeText.textFormatColorLabel}
          value={color ?? ''}
          onChange={(v) => onColorChange(v || undefined)}
          placeholder={localeText.textFormatColorPlaceholder}
        />

        <div>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            {localeText.textFormatAlignmentLabel}
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={align ?? 'left'}
            onChange={(_event, val) => {
              if (val) {
                onAlignChange(val === 'left' ? undefined : (val as 'center' | 'right'));
              }
            }}
          >
            <ToggleButton value="left" aria-label={localeText.textFormatAlignLeftAriaLabel}>
              <FormatAlignLeftIcon fontSize="small" />
            </ToggleButton>
            <ToggleButton value="center" aria-label={localeText.textFormatAlignCenterAriaLabel}>
              <FormatAlignCenterIcon fontSize="small" />
            </ToggleButton>
            <ToggleButton value="right" aria-label={localeText.textFormatAlignRightAriaLabel}>
              <FormatAlignRightIcon fontSize="small" />
            </ToggleButton>
          </ToggleButtonGroup>
        </div>
      </Stack>
    </CollapsibleSection>
  );
}

export function TextFormatPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const config = useStudioSelector(selectWidgets)[widgetId]?.config;
  const localeText = useStudioLocaleText();

  if (!config) {
    return null;
  }

  const update = (changes: Partial<StudioWidgetConfig>) =>
    controller.updateWidgetConfig(widgetId, changes);

  return (
    <Stack spacing={1.5}>
      <TextSectionFormat
        label={localeText.textSetupTitleLabel}
        fontFamily={config.textTitleFontFamily}
        fontSize={config.textTitleFontSize}
        color={config.textTitleColor}
        align={config.textTitleAlign}
        onFontFamilyChange={(v) => update({ textTitleFontFamily: v })}
        onFontSizeChange={(v) => update({ textTitleFontSize: v })}
        onColorChange={(v) => update({ textTitleColor: v })}
        onAlignChange={(v) => update({ textTitleAlign: v })}
      />
      <TextSectionFormat
        label={localeText.textSetupSubtitleLabel}
        fontFamily={config.textSubtitleFontFamily}
        fontSize={config.textSubtitleFontSize}
        color={config.textSubtitleColor}
        align={config.textSubtitleAlign}
        onFontFamilyChange={(v) => update({ textSubtitleFontFamily: v })}
        onFontSizeChange={(v) => update({ textSubtitleFontSize: v })}
        onColorChange={(v) => update({ textSubtitleColor: v })}
        onAlignChange={(v) => update({ textSubtitleAlign: v })}
      />
      <TextSectionFormat
        label={localeText.textSetupBodyLabel}
        fontFamily={config.textBodyFontFamily}
        fontSize={config.textBodyFontSize}
        color={config.textBodyColor}
        align={config.textBodyAlign}
        onFontFamilyChange={(v) => update({ textBodyFontFamily: v })}
        onFontSizeChange={(v) => update({ textBodyFontSize: v })}
        onColorChange={(v) => update({ textBodyColor: v })}
        onAlignChange={(v) => update({ textBodyAlign: v })}
      />
    </Stack>
  );
}
