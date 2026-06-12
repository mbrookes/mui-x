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
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { CollapsibleSection } from '../../internals/CollapsibleSection';
import { ColorInput } from './ColorInput';

export interface TextSectionFormatProps {
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

export function TextSectionFormat(props: TextSectionFormatProps) {
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
