import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEMANTIC_MODEL_ID,
  createDefaultSemanticModel,
  isSemanticModelExternal,
  resolveSemanticModel,
} from './semanticModel';
import type { StudioSemanticModel } from './semanticModel';
import { createDefaultStudioState } from './factories';
import { deserializeState, serializeState } from './statePersistence';

/**
 * The semantic model's identity and resolution (ADR 0004).
 *
 * `relationships` and `expressionFields` used to sit directly on `StudioDoc`. Moving them under a
 * NAMED model is the whole change: an id is what lets two dashboards assert they mean the same
 * model, and therefore what lets a host define `revenue` once instead of each document redeclaring
 * it. Everything below is a property of that naming.
 */

const HOST_MODEL: StudioSemanticModel = {
  id: DEFAULT_SEMANTIC_MODEL_ID,
  label: 'Governed',
  relationships: [
    {
      id: 'r-host',
      sourceId: 'orders',
      sourceField: 'customerId',
      targetId: 'customers',
      targetField: 'id',
      type: 'many-to-one',
    },
  ],
  expressionFields: [],
};

function stateWithOwnModel(model?: Partial<StudioSemanticModel>) {
  return createDefaultStudioState({
    doc: { semanticModel: { ...createDefaultSemanticModel(), ...model } },
  });
}

describe('resolveSemanticModel', () => {
  it("returns the document's own model when the host supplied none", () => {
    // The overwhelmingly common case, and the one that keeps a dashboard a self-contained
    // artifact: no registry, no indirection anyone has to know about.
    const state = stateWithOwnModel();
    expect(resolveSemanticModel(state)).toBe(state.doc.semanticModel);
    expect(isSemanticModelExternal(state)).toBe(false);
  });

  it('prefers a host model registered under the same id', () => {
    // Override by ID, not by a flag or a separate pointer — which is what makes the two branches
    // one mechanism. The document is not edited; it simply resolves differently in a host that has
    // a governed definition of what it names.
    const state = stateWithOwnModel();
    const withHost = {
      ...state,
      runtime: { ...state.runtime, semanticModels: { [DEFAULT_SEMANTIC_MODEL_ID]: HOST_MODEL } },
    };
    expect(resolveSemanticModel(withHost)).toBe(HOST_MODEL);
    expect(isSemanticModelExternal(withHost)).toBe(true);
  });

  it('ignores a host model registered under a different id', () => {
    // Naming is the whole contract. A host model called something else is a different model, and
    // silently applying it would redefine a dashboard's measures behind its author's back.
    const state = stateWithOwnModel();
    const withHost = {
      ...state,
      runtime: {
        ...state.runtime,
        semanticModels: { warehouse: { ...HOST_MODEL, id: 'warehouse' } },
      },
    };
    expect(resolveSemanticModel(withHost)).toBe(state.doc.semanticModel);
  });

  it("leaves the document's own model intact while it is overridden", () => {
    // The property that keeps this reversible. An exported dashboard is still self-contained, and
    // still opens correctly in a host with no registry at all — so adopting a shared model is not
    // a one-way door.
    const own = { ...createDefaultSemanticModel(), label: 'Mine' };
    const state = createDefaultStudioState({ doc: { semanticModel: own } });
    const withHost = {
      ...state,
      runtime: { ...state.runtime, semanticModels: { [DEFAULT_SEMANTIC_MODEL_ID]: HOST_MODEL } },
    };
    expect(resolveSemanticModel(withHost)).toBe(HOST_MODEL);
    expect(withHost.doc.semanticModel.label).toBe('Mine');
  });
});

describe('semantic model persistence', () => {
  it('round-trips the model with its id', () => {
    const state = stateWithOwnModel({ id: 'warehouse', relationships: HOST_MODEL.relationships });
    const restored = deserializeState(serializeState(state), {});
    expect(restored.doc.semanticModel.id).toBe('warehouse');
    expect(restored.doc.semanticModel.relationships).toHaveLength(1);
  });

  it("serializes the document's own model, never the host override", () => {
    // Serializing the resolved model would bake somebody else's definitions into this dashboard
    // and make the override permanent and invisible the next time the document was opened.
    const state = stateWithOwnModel();
    const withHost = {
      ...state,
      runtime: { ...state.runtime, semanticModels: { [DEFAULT_SEMANTIC_MODEL_ID]: HOST_MODEL } },
    };
    expect(serializeState(withHost).semanticModel).toBeUndefined();
  });

  it('omits an empty model from the wire', () => {
    // A fresh dashboard always HAS a model, so keying on the object would put a meaningless key in
    // every exported document.
    expect(serializeState(stateWithOwnModel()).semanticModel).toBeUndefined();
  });

  it('reads a pre-ADR document that stores the arrays at the top level', () => {
    // x-studio is unpublished, so this is not a compatibility promise — it exists because the
    // alternative is that a developer with a dashboard saved from last week's build silently loses
    // every join and calculated field, which would read as a bug in the dashboard rather than as a
    // format change.
    const legacy = {
      ...serializeState(stateWithOwnModel()),
      relationships: HOST_MODEL.relationships,
    } as unknown as ReturnType<typeof serializeState>;
    const restored = deserializeState(legacy, {});
    expect(restored.doc.semanticModel.relationships).toHaveLength(1);
    expect(restored.doc.semanticModel.id).toBe(DEFAULT_SEMANTIC_MODEL_ID);
  });
});
