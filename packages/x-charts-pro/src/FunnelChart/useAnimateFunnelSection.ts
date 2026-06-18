'use client';
import { interpolateString } from '@mui/x-charts-vendor/d3-interpolate';
import type * as React from 'react';
import { useAnimate } from '@mui/x-charts/hooks';

type UseAnimateFunnelSectionParams = {
  d: string;
  skipAnimation?: boolean;
  ref?: React.Ref<SVGPathElement>;
};

type UseAnimateFunnelSectionReturn = {
  ref: React.Ref<SVGPathElement>;
  d: string;
};

export function useAnimateFunnelSection({
  d,
  skipAnimation,
  ref,
}: UseAnimateFunnelSectionParams): UseAnimateFunnelSectionReturn {
  return useAnimate(
    { d },
    {
      createInterpolator: (lastProps, newProps) => {
        const interpolate = interpolateString(lastProps.d, newProps.d);
        return (t) => ({ d: interpolate(t) });
      },
      applyProps: (element: SVGPathElement, { d: animD }) => element.setAttribute('d', animD),
      transformProps: (p) => p,
      skip: skipAnimation,
      ref,
    },
  );
}
