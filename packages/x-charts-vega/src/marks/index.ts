import type { VegaMarkType } from '../types';
import type { CompiledUnit, UnitContext } from '../compile/context';
import { compileArcMark } from './arc';
import { compileBarMark } from './bar';
import { compileBoxplotMark } from './boxplot';
import { compileErrorBarMark } from './errorBar';
import { compileGeoshapeMark } from './geoshape';
import { compileImageMark } from './imageMark';
import { compileLineAreaMark } from './lineArea';
import { compilePointMark } from './point';
import { compileRectMark } from './rect';
import { compileRuleMark } from './rule';
import { compileTextMark } from './textMark';

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
  boxplot: compileBoxplotMark,
  errorbar: compileErrorBarMark,
  errorband: compileErrorBarMark,
  text: compileTextMark,
  image: compileImageMark,
};

/** Hints for mark strings the registry has no compiler for. */
export const UNSUPPORTED_MARK_HINTS: Record<string, string> = {};
