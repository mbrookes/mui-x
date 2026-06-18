'use client';
import * as React from 'react';
import { styled, useTheme } from '@mui/material/styles';
import { consumeSlots, type SeriesId } from '@mui/x-charts/internals';
import { useItemHighlightState } from '@mui/x-charts/hooks';
import clsx from 'clsx';
import { useUtilityClasses, type FunnelClasses } from './funnelClasses';

export interface FunnelSectionLabelConfig {
  x: number;
  y: number;
  value: string | null;
  textAnchor?: React.SVGProps<SVGTextElement>['textAnchor'];
  dominantBaseline?: React.SVGProps<SVGTextElement>['dominantBaseline'];
}

export interface FunnelSectionLabelProps extends Omit<
  React.SVGProps<SVGTextElement>,
  'ref' | 'id'
> {
  classes?: Partial<FunnelClasses>;
  label: FunnelSectionLabelConfig;
  /**
   * Indicate if the section is filled or outlined.
   * Can be used to apply different styles to the label.
   */
  variant?: 'filled' | 'outlined';
  seriesId: SeriesId;
  dataIndex: number;
}

export const FunnelSectionLabelText = styled('text', {
  name: 'MuiFunnelChart',
  slot: 'SectionLabel',
})(() => ({
  transition:
    'opacity 0.2s ease-in, fill 0.2s ease-in, fill-opacity 0.2s ease-in, filter 0.2s ease-in',
}));

/**
 * @ignore - internal component.
 */
const FunnelSectionLabel = consumeSlots<FunnelSectionLabelProps, SVGTextElement>(
  'MuiFunnelSectionLabel',
  'funnelSectionLabel',
  {
    classesResolver: useUtilityClasses,
  },
  React.forwardRef(function FunnelSectionLabel(
    props: FunnelSectionLabelProps,
    ref: React.Ref<SVGTextElement>,
  ) {
    const { classes, color, onClick, className, label, variant, seriesId, dataIndex, ...other } =
      props;
    const theme = useTheme();

    const identifier = React.useMemo(
      () => ({ type: 'funnel' as const, seriesId, dataIndex }),
      [seriesId, dataIndex],
    );

    const highlightState = useItemHighlightState(identifier);
    const isHighlighted = highlightState === 'highlighted';
    const isFaded = highlightState === 'faded';
    const isOutlined = variant === 'outlined';

    return (
      <FunnelSectionLabelText
        stroke="none"
        pointerEvents="none"
        opacity={isFaded && !isOutlined ? 0.3 : 1}
        filter={isHighlighted && !isOutlined ? 'brightness(120%)' : undefined}
        fontFamily={theme.typography.body2.fontFamily}
        fontSize={theme.typography.body2.fontSize}
        fontSizeAdjust={theme.typography.body2.fontSizeAdjust}
        fontWeight={theme.typography.body2.fontWeight}
        letterSpacing={theme.typography.body2.letterSpacing}
        fontStretch={theme.typography.body2.fontStretch}
        fontStyle={theme.typography.body2.fontStyle}
        fontVariant={theme.typography.body2.fontVariant}
        fill={(theme.vars || theme)?.palette?.text?.primary}
        className={clsx(classes?.sectionLabel, className)}
        x={label.x}
        y={label.y}
        textAnchor={label.textAnchor ?? 'middle'}
        dominantBaseline={label.dominantBaseline ?? 'central'}
        {...other}
        ref={ref}
      >
        {label.value}
      </FunnelSectionLabelText>
    );
  }),
);

export { FunnelSectionLabel };
