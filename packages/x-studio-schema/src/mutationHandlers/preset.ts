/** Filter-preset mutations. Thin by design — each delegates to a `docTransforms` function. */
import * as docTransforms from '../docTransforms';
import type { HandlersFor } from './shared';

export const PRESET_MUTATION_HANDLERS: HandlersFor<
  'saveFilterPreset' | 'applyFilterPreset' | 'deleteFilterPreset' | 'renameFilterPreset'
> = {
  /*
   * ── Filter presets and managed date-range filters ──────────────────────────────────────
   *
   * Thin dispatchers onto `docTransforms.ts`. The bodies stay there — they are long, heavily
   * documented, and independently tested — and this table is how they are REACHED, which is the
   * point: before this, they were a parallel pure-transform layer the controller called
   * directly, so a doc edit went through `applyMutation` or through `docTransforms` depending
   * on which writer you happened to be in.
   *
   * Every one already honours the reference-equality no-op contract internally (returning the
   * SAME doc when nothing changed), which is why no handler here re-checks it.
   */
  saveFilterPreset: {
    apply: (state, args) =>
      typeof args.presetId === 'string' && typeof args.name === 'string'
        ? docTransforms.saveFilterPreset(state, args.presetId, args.name)
        : state,
    label: (args) => `saveFilterPreset:${args.name}`,
  },

  applyFilterPreset: {
    apply: (state, args) =>
      typeof args.presetId === 'string'
        ? docTransforms.applyFilterPreset(state, args.presetId)
        : state,
    label: (args) => `applyFilterPreset:${args.presetId}`,
  },

  deleteFilterPreset: {
    apply: (state, args) =>
      typeof args.presetId === 'string'
        ? docTransforms.deleteFilterPreset(state, args.presetId)
        : state,
    label: (args) => `deleteFilterPreset:${args.presetId}`,
  },

  renameFilterPreset: {
    apply: (state, args) =>
      typeof args.presetId === 'string' && typeof args.name === 'string'
        ? docTransforms.renameFilterPreset(state, args.presetId, args.name)
        : state,
    label: (args) => `renameFilterPreset:${args.presetId}`,
  },
};
