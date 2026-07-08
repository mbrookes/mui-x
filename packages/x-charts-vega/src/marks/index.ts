import type { VegaMarkType } from '../types';
import type { CompiledUnit, UnitContext } from '../compile/context';
import { compileArcMark } from './arc';
import { compileBarMark } from './bar';
import { compileGeoshapeMark } from './geoshape';
import { compileLineAreaMark } from './lineArea';
import { compilePointMark } from './point';
import { compileRectMark } from './rect';
import { compileRuleMark } from './rule';

export type MarkCompiler = (ctx: UnitContext) => CompiledUnit;

/**
 * Mark-type dispatch table. Marks not present here are unmappable to
 * x-charts primitives and produce an `unsupported` gap with a pointer to the
 * closest alternative (see UNSUPPORTED_MARK_HINTS).
 */
export const markRegistry: Partial<Record<VegaMarkType, MarkCompiler>> = {
  bar: compileBarMark,
  line: compileLineAreaMark,
  area: compileLineAreaMark,
  trail: compileLineAreaMark,
  point: compilePointMark,
  circle: compilePointMark,
  square: compilePointMark,
  tick: compilePointMark,
  arc: compileArcMark,
  rule: compileRuleMark,
  rect: compileRectMark,
  geoshape: compileGeoshapeMark,
};

/** Why each unregistered mark is out of reach in any x-charts tier. */
export const UNSUPPORTED_MARK_HINTS: Record<string, string> = {
  boxplot: 'boxplot has no x-charts equivalent in any tier.',
  errorbar:
    'errorbar has no x-charts primitive; approximate with layered rule marks once supported.',
  errorband: 'errorband has no x-charts primitive.',
  image: 'image marks have no x-charts equivalent.',
  text: 'free text marks have no composition primitive; only bar labels / arc labels exist in x-charts.',
};
