'use client';
import * as React from 'react';
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

interface TextSectionFormatProps {
  label: string;
  /**
   * Identifies the entity this section edits (e.g. `` `${widgetId}:title` ``), forwarded to
   * the buffered `ColorInput` so an uncommitted colour edit is discarded rather than leaked
   * onto a different widget/section holding the same value. See M2 in `ColorInput.tsx`.
   */
  identity?: string;
  /** A named keyword or a literal CSS font-family stack. */
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  onFontFamilyChange: (v: string | undefined) => void;
  onFontSizeChange: (v: number | undefined) => void;
  onColorChange: (v: string | undefined) => void;
  onAlignChange: (v: 'left' | 'center' | 'right' | undefined) => void;
}

const NAMED_FONTS = ['sans-serif', 'serif', 'monospace'];

/** Font sizes (px) offered in the size picker, rendered via `textFormatFontSizeOption`. */
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 32, 40];

export function TextSectionFormat(props: TextSectionFormatProps) {
  const {
    label,
    identity,
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
  // MUI's `Select` only emits `aria-labelledby` when handed an explicit `labelId`, and
  // `InputLabel` does not derive an `id`/`htmlFor` from `FormControl` context (its `label`
  // prop only sizes the outline notch), so an unpaired combobox has no accessible name.
  // Unique per mount so several mounted sections never emit duplicate DOM ids.
  const fontFamilyLabelId = React.useId();
  const fontSizeLabelId = React.useId();

  return (
    <CollapsibleSection title={label}>
      <Stack spacing={1.5} sx={{ pb: 1.5 }}>
        <FormControl size="small" fullWidth>
          <InputLabel id={fontFamilyLabelId}>{localeText.textFormatFontFamilyLabel}</InputLabel>
          <Select
            labelId={fontFamilyLabelId}
            label={localeText.textFormatFontFamilyLabel}
            value={fontFamily ?? ''}
            onChange={(event) => {
              const v = event.target.value as string;
              onFontFamilyChange(v === '' ? undefined : v);
            }}
          >
            <MenuItem value="">{localeText.textFormatDefaultFont}</MenuItem>
            <MenuItem value="sans-serif">{localeText.textFormatSansSerifFont}</MenuItem>
            <MenuItem value="serif">{localeText.textFormatSerifFont}</MenuItem>
            <MenuItem value="monospace">{localeText.textFormatMonospaceFont}</MenuItem>
            {/* A custom CSS font stack (set programmatically) keeps the Select in range. */}
            {fontFamily && !NAMED_FONTS.includes(fontFamily) ? (
              <MenuItem value={fontFamily}>{fontFamily}</MenuItem>
            ) : null}
          </Select>
        </FormControl>

        <FormControl size="small" fullWidth>
          <InputLabel id={fontSizeLabelId}>{localeText.textFormatFontSizeLabel}</InputLabel>
          <Select
            labelId={fontSizeLabelId}
            label={localeText.textFormatFontSizeLabel}
            value={fontSize ?? 0}
            onChange={(event) => {
              const v = Number(event.target.value);
              onFontSizeChange(v === 0 ? undefined : v);
            }}
          >
            <MenuItem value={0}>{localeText.textFormatDefaultSize}</MenuItem>
            {FONT_SIZES.map((px) => (
              <MenuItem key={px} value={px}>
                {localeText.textFormatFontSizeOption(px)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <ColorInput
          label={localeText.textFormatColorLabel}
          identity={identity}
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
