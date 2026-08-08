import { describe, expect, it } from 'vitest';
import { createDefaultWidget } from '@mui/x-studio-schema';
import { StudioController } from './StudioController';

/**
 * Unsaved-changes tracking (AG_STUDIO_GAP_ANALYSIS XS-STATE-003).
 *
 * The package persists nothing itself, so "saved" can only mean "since the host last said so".
 * What it CAN do is answer the question accurately, which the host cannot: only the controller
 * knows whether the document actually changed, as opposed to whether something happened.
 *
 * The whole design rests on `doc` being immutable and reference-compared. Every property below is
 * a consequence of that, and the undo case is the one a naive implementation gets wrong.
 */

function seedWidget(controller: StudioController) {
  const pageId = controller.getState().doc.dashboard.activePageId;
  const rows = controller.getState().doc.pages[pageId].widgetRows;
  const widget = { ...createDefaultWidget('text'), id: 'w1' };
  controller.insertWidgetAt(widget, pageId, [...rows, ['w1']]);
}

describe('StudioController dirty tracking', () => {
  it('starts clean', () => {
    // A host that seeded the controller from persisted state has not changed that state, so
    // reporting "unsaved changes" before the user has touched anything would make the indicator
    // wrong at the one moment it is guaranteed to be looked at.
    expect(new StudioController().isDirty()).to.equal(false);
  });

  it('becomes dirty on a document edit', () => {
    const controller = new StudioController();
    seedWidget(controller);
    expect(controller.isDirty()).to.equal(true);
  });

  it('stays clean for a session-only change', () => {
    // Mode and selection live in the `session` partition, which is never persisted. Switching to
    // view mode is not an unsaved change, and an indicator that said so would train users to
    // ignore it.
    const controller = new StudioController();
    controller.setMode('view');
    controller.setSelectedWidget(null);
    expect(controller.isDirty()).to.equal(false);
  });

  it('clears on markSaved', () => {
    const controller = new StudioController();
    seedWidget(controller);
    controller.markSaved();
    expect(controller.isDirty()).to.equal(false);
  });

  it('goes dirty again after a further edit', () => {
    const controller = new StudioController();
    seedWidget(controller);
    controller.markSaved();
    controller.updateWidget('w1', { title: 'Renamed' });
    expect(controller.isDirty()).to.equal(true);
  });

  it('reads clean again when an edit is undone back to the saved document', () => {
    // THE property that makes reference identity the right mechanism rather than merely a cheap
    // one. Undo swaps in the `StudioDoc` snapshot from the history stack — the same object that
    // was current before the edit — so undoing back to the saved state restores the saved
    // REFERENCE and the dashboard is genuinely unmodified again.
    //
    // A "number of edits since save" counter reports this as dirty forever, which is wrong in the
    // most annoying possible way: the user undid their change and the app still refuses to let
    // them leave.
    const controller = new StudioController();
    seedWidget(controller);
    controller.markSaved();

    controller.updateWidget('w1', { title: 'Renamed' });
    expect(controller.isDirty()).to.equal(true);

    controller.undo();
    expect(controller.isDirty()).to.equal(false);
  });

  it('is dirty again on redo', () => {
    const controller = new StudioController();
    seedWidget(controller);
    controller.markSaved();
    controller.updateWidget('w1', { title: 'Renamed' });
    controller.undo();
    controller.redo();
    expect(controller.isDirty()).to.equal(true);
  });

  it('treats a freshly loaded document as saved', () => {
    // Loading is not editing. Without the re-baseline the load itself reads as a change, so a
    // host renders "unsaved changes" on a dashboard the user has not opened yet.
    const controller = new StudioController();
    seedWidget(controller);
    const serialized = controller.serializeState();

    const other = new StudioController();
    other.loadSerializedState(serialized);

    expect(other.isDirty()).to.equal(false);
  });

  it('notifies subscribers when the saved baseline moves', () => {
    // `markSaved` changes no state — only the baseline — so without an explicit notification a
    // dirty indicator would keep rendering "unsaved changes" after a successful save until some
    // unrelated commit happened to re-render it.
    const controller = new StudioController();
    seedWidget(controller);
    let notifications = 0;
    const unsubscribe = controller.store.subscribe(() => {
      notifications += 1;
    });

    controller.markSaved();

    expect(notifications).to.be.greaterThan(0);
    unsubscribe();
  });

  it('does not notify when there was nothing to save', () => {
    // A host calling `markSaved` on an autosave tick should not cost a render per tick.
    const controller = new StudioController();
    let notifications = 0;
    const unsubscribe = controller.store.subscribe(() => {
      notifications += 1;
    });

    controller.markSaved();
    controller.markSaved();

    expect(notifications).to.equal(0);
    unsubscribe();
  });

  it('leaves the state partitions reference-identical when it notifies', () => {
    // The notification carries a fresh state WRAPPER only. Every slice-based `useStudioSelector`
    // bails out on `Object.is`, so saving does not re-render the dashboard — only the consumers
    // actually reading `isDirty()`.
    const controller = new StudioController();
    seedWidget(controller);
    const before = controller.getState();

    controller.markSaved();

    const after = controller.getState();
    expect(after).to.not.equal(before);
    expect(after.doc).to.equal(before.doc);
    expect(after.session).to.equal(before.session);
    expect(after.runtime).to.equal(before.runtime);
  });
});
