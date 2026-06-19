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

// Extract path command letters only (strip numbers) to detect curve-type changes.
// When switching from e.g. 'linear' (M L L Z) to 'bump' (M C C Z), the structures
// differ and interpolateString would produce broken intermediate shapes.
function getPathCommandStructure(d: string): string {
  return d.replace(/[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/g, '').replace(/\s+/g, '');
}

export function useAnimateFunnelSection({
  d,
  skipAnimation,
  ref,
}: UseAnimateFunnelSectionParams): UseAnimateFunnelSectionReturn {
  return useAnimate(
    { d },
    {
      createInterpolator: (lastProps, newProps) => {
        // When the curve type changes the path command structure is incompatible with
        // interpolateString — skip to the final shape instantly to avoid garbled morphs.
        if (getPathCommandStructure(lastProps.d) !== getPathCommandStructure(newProps.d)) {
          return (_t: number) => ({ d: newProps.d });
        }
        const interpolate = interpolateString(lastProps.d, newProps.d);
        return (t: number) => ({ d: interpolate(t) });
      },
      applyProps: (element: SVGPathElement, { d: animD }) => element.setAttribute('d', animD),
      transformProps: (p) => p,
      skip: skipAnimation,
      ref,
    },
  );
}
