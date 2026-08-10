import { describe, expect, it, vi, afterEach } from 'vitest';
import { DEFAULT_SEMANTIC_MODEL_ID, createDefaultSemanticModel } from '@mui/x-studio-schema';
import type { StudioSemanticModel } from '@mui/x-studio-schema';
import { StudioController } from './StudioController';

/**
 * Editing a host-provided semantic model (ADR 0004).
 *
 * The reducer writes to the DOCUMENT's model. When a host has registered a model under the same
 * id, `resolveSemanticModel` returns the host's — so an accepted edit would land somewhere no read
 * looks: the author changes a join, saves, and the dashboard is unchanged with no explanation.
 *
 * Declining is the deliberate outcome, not a limitation to route around. Editing a shared model
 * needs a permission story and a versioning story (ADR 0004 option 3), and inventing either one
 * silently inside a setter is how a governed model stops being governed.
 */

const HOST_MODEL: StudioSemanticModel = {
  id: DEFAULT_SEMANTIC_MODEL_ID,
  relationships: [],
  expressionFields: [],
};

function controllerWithHostModel() {
  const controller = new StudioController();
  // Written straight into the store: `semanticModels` is host-injected runtime state, and the
  // point of the test is what happens once it is there.
  controller.store.setState({
    ...controller.store.state,
    runtime: {
      ...controller.store.state.runtime,
      semanticModels: { [DEFAULT_SEMANTIC_MODEL_ID]: HOST_MODEL },
    },
  });
  return controller;
}

const RELATIONSHIP = {
  id: 'r1',
  sourceId: 'orders',
  sourceField: 'customerId',
  targetId: 'customers',
  targetField: 'id',
  type: 'many-to-one' as const,
};

const FIELD = {
  id: 'ef1',
  label: 'Margin',
  sourceId: 'orders',
  isMeasure: false,
  expression: { operator: 'subtract' as const, inputs: [{ id: 'revenue' }, { id: 'cost' }] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('semantic-model edits under a host-provided model', () => {
  it('declines a relationship edit with a reason rather than failing silently', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = controllerWithHostModel();

    const result = controller.addRelationship(RELATIONSHIP);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('external-semantic-model');
    // And nothing was written: a rejected mutation must not leave a half-applied document.
    expect(controller.getState().doc.semanticModel.relationships).toHaveLength(0);
  });

  it('declines an expression-field edit the same way', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = controllerWithHostModel();

    const result = controller.addExpressionField(FIELD);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('external-semantic-model');
    expect(controller.getState().doc.semanticModel.expressionFields).toHaveLength(0);
  });

  it('says why, so the refusal is diagnosable', () => {
    // A rejection code reaches the UI; it does not reach the developer wondering why their
    // dashboard ignores them.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    controllerWithHostModel().addRelationship(RELATIONSHIP);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('semantic model supplied by the host');
  });

  it('does not consume an undo slot for a declined edit', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = controllerWithHostModel();
    const before = controller.getState().doc;

    controller.addRelationship(RELATIONSHIP);

    // Reference-identical: the doc never moved, so there is nothing to undo back past.
    expect(controller.getState().doc).toBe(before);
    expect(controller.canUndo()).toBe(false);
  });

  it("allows the same edits when the model is the document's own", () => {
    // The guard must be scoped to the override, not to semantic-model editing in general.
    const controller = new StudioController({
      doc: { semanticModel: createDefaultSemanticModel() },
    });

    expect(controller.addRelationship(RELATIONSHIP).ok).toBe(true);
    expect(controller.addExpressionField(FIELD).ok).toBe(true);
    expect(controller.getState().doc.semanticModel.relationships).toHaveLength(1);
    expect(controller.getState().doc.semanticModel.expressionFields).toHaveLength(1);
  });
});
