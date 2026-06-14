'use client';
import { Stack } from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  useStudioLocaleText,
} from '../../context';
import type { StudioWidgetConfig } from '../../models';
import { TextSectionFormat } from './TextSectionFormat';

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
