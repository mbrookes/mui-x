'use client';
import * as React from 'react';
import { FunnelSection, type FunnelSectionProps } from './FunnelSection';
import { useAnimateFunnelSection } from './useAnimateFunnelSection';

export interface AnimatedFunnelSectionProps extends FunnelSectionProps {
  /**
   * If `true`, animations are skipped.
   * @default false
   */
  skipAnimation?: boolean;
}

export const AnimatedFunnelSection = React.forwardRef<SVGPathElement, AnimatedFunnelSectionProps>(
  function AnimatedFunnelSection(props, ref) {
    const { skipAnimation, d, ...other } = props;

    const animatedProps = useAnimateFunnelSection({
      d: d as string,
      skipAnimation,
      ref,
    });

    return <FunnelSection {...other} d={animatedProps.d} ref={animatedProps.ref} />;
  },
);
