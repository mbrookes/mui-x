/**
 * Data-model mutations: relationships between sources, and expression (computed) fields.
 *
 * Grouped together because both describe the SHAPE of the data rather than its presentation, and
 * both are pure record edits with no layout consequences.
 */
import { isPlainRecord } from '../internalGuards';
import type { HandlersFor } from './shared';

export const MODEL_MUTATION_HANDLERS: HandlersFor<
  | 'addRelationship'
  | 'updateRelationship'
  | 'removeRelationship'
  | 'addExpressionField'
  | 'updateExpressionField'
  | 'removeExpressionField'
> = {
  /*
   * ── Relationships and expression fields ────────────────────────────────────────────────
   *
   * Deliberately thin. Unlike the filter drops above, these carry no cross-entity invariant for
   * the reducer to enforce — no cascade, no scope screen, no rank conflict — so the handlers are
   * exactly the write plus the reference-equality no-op contract every reducer path owes its
   * caller. The value is uniformity: a doc edit goes through one function whatever reached it,
   * which is what makes "the reducer is the one implementation of every mutation's effect" true
   * rather than nearly true.
   */
  addRelationship: {
    apply: (state, args) => {
      const { relationship } = args;
      if (!isPlainRecord(relationship) || typeof relationship.id !== 'string') {
        return state;
      }
      // Re-delivery safe, matching `addWidget`: an id already present returns the SAME doc, so a
      // duplicated envelope is a clean no-op rather than a second entry.
      if (state.relationships.some((rel) => rel.id === relationship.id)) {
        return state;
      }
      return { ...state, relationships: [...state.relationships, relationship] };
    },
    label: (args) => `addRelationship:${args.relationship?.id}`,
  },

  updateRelationship: {
    apply: (state, args) => {
      const { relationshipId, patch } = args;
      if (typeof relationshipId !== 'string' || !isPlainRecord(patch)) {
        return state;
      }
      let changed = false;
      const next = state.relationships.map((rel) => {
        if (rel.id !== relationshipId) {
          return rel;
        }
        const keys = Object.keys(patch) as (keyof typeof patch)[];
        if (keys.every((key) => patch[key] === rel[key])) {
          return rel;
        }
        changed = true;
        return { ...rel, ...patch };
      });
      return changed ? { ...state, relationships: next } : state;
    },
    label: (args) => `updateRelationship:${args.relationshipId}`,
  },

  removeRelationship: {
    apply: (state, args) => {
      const { relationshipId } = args;
      if (typeof relationshipId !== 'string') {
        return state;
      }
      const next = state.relationships.filter((rel) => rel.id !== relationshipId);
      return next.length === state.relationships.length ? state : { ...state, relationships: next };
    },
    label: (args) => `removeRelationship:${args.relationshipId}`,
  },

  addExpressionField: {
    apply: (state, args) => {
      const { field } = args;
      if (!isPlainRecord(field) || typeof field.id !== 'string') {
        return state;
      }
      if (state.expressionFields.some((ef) => ef.id === field.id)) {
        return state;
      }
      return { ...state, expressionFields: [...state.expressionFields, field] };
    },
    label: (args) => `addExpressionField:${args.field?.id}`,
  },

  updateExpressionField: {
    apply: (state, args) => {
      const { fieldId, updates } = args;
      if (typeof fieldId !== 'string' || !isPlainRecord(updates)) {
        return state;
      }
      let changed = false;
      const next = state.expressionFields.map((ef) => {
        if (ef.id !== fieldId) {
          return ef;
        }
        const keys = Object.keys(updates) as (keyof typeof updates)[];
        if (keys.every((key) => updates[key] === ef[key])) {
          return ef;
        }
        changed = true;
        // `id` is never patchable: the args type omits it, and re-asserting it here keeps that
        // true for an untyped caller too.
        return { ...ef, ...updates, id: ef.id };
      });
      return changed ? { ...state, expressionFields: next } : state;
    },
    label: (args) => `updateExpressionField:${args.fieldId}`,
  },

  removeExpressionField: {
    apply: (state, args) => {
      const { fieldId } = args;
      if (typeof fieldId !== 'string') {
        return state;
      }
      const next = state.expressionFields.filter((ef) => ef.id !== fieldId);
      // Dangling references are deliberately NOT cascaded: a widget or filter naming a removed
      // field keeps naming it, resolving to no value. The controller warns with a reference
      // count so the author can repoint them. Silently rewriting a widget's own config to
      // absorb a data-model deletion would be the more surprising behaviour.
      return next.length === state.expressionFields.length
        ? state
        : { ...state, expressionFields: next };
    },
    label: (args) => `removeExpressionField:${args.fieldId}`,
  },
};
