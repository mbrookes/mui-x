/**
 * Runtime type guards for narrowing a `StudioWidget` to a single kind.
 *
 * WHY THIS EXISTS (important): `StudioWidget` includes a catch-all
 * `StudioWidgetOf<string & {}>` member so consumer-defined CUSTOM widget kinds
 * are first-class (a shipping feature). That member's `kind` is a non-literal
 * `string`, which means the union is NOT a TypeScript discriminated union — so a
 * bare `if (widget.kind === 'chart')` check does NOT narrow `widget.config` to
 * the chart config (TS keeps every member because `string` could equal
 * `'chart'`). This guard performs the same runtime check but ASSERTS the precise
 * `StudioWidgetOf<K>` result type, restoring per-kind config narrowing at the
 * cross-kind read sites (dispatchers, registries, summary/insight builders).
 *
 * Single-kind components should instead type their prop directly as
 * `StudioWidgetOf<'chart'>` (no guard needed); this guard is for the genuinely
 * cross-kind sites that branch on `widget.kind`.
 */
import type { BuiltinStudioWidgetKind } from './baseTypes';
import type { StudioWidget, StudioWidgetOf } from './widgetTypes';

/**
 * Narrows `widget` to `StudioWidgetOf<K>` when its `kind` matches `kind`.
 * Use in place of a bare `widget.kind === kind` check when you then need to read
 * `widget.config`'s kind-specific keys.
 */
export function isWidgetOfKind<K extends BuiltinStudioWidgetKind>(
  widget: StudioWidget,
  kind: K,
): widget is StudioWidgetOf<K> {
  return widget.kind === kind;
}
