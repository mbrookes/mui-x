import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioChartAnnotation } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { AnnotationsEditorSection } from './AnnotationsEditorSection';

const controller = {
  updateWidgetConfig: vi.fn(),
};

const mockState = { doc: { widgets: {} }, runtime: { dataSources: {} } };

vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

function renderAnnotations(annotations: StudioChartAnnotation[]) {
  return render(<AnnotationsEditorSection widgetId="widget-1" config={{ annotations }} />);
}

// Finding 1.14: the reference-line value input re-rendered its controlled `value`
// straight from the doc on every keystroke, so a still-typing "10." round-tripped
// through `Number('10.')` → `10` → back into the field as "10", eating the
// trailing decimal point mid-edit. It now buffers the displayed text locally and
// only parses/commits on blur.
describe('AnnotationsEditorSection reference-line value input (finding 1.14)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('preserves a trailing decimal point while typing', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: '' }]);
    const input = screen.getByLabelText('Value') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10.' } });
    expect(input.value).toBe('10.');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits the completed decimal value on blur', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: '' }]);
    const input = screen.getByLabelText('Value') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10.5' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      annotations: [expect.objectContaining({ id: 'ann-1', value: 10.5 })],
    });
  });

  it('does not commit a still-typing bare "-" before blur', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: '' }]);
    const input = screen.getByLabelText('Value') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-' } });
    expect(input.value).toBe('-');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('reverts an emptied field to the last committed value on blur, without committing 0', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: '' }]);
    const input = screen.getByLabelText('Value') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(input.value).toBe('10');
  });

  it('still supports a non-numeric axis-label value for an x-axis annotation', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'x', value: 'Q1', label: '' }]);
    const input = screen.getByLabelText('Value') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Q2' } });
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      annotations: [expect.objectContaining({ id: 'ann-1', value: 'Q2' })],
    });
  });
});

// Finding 2.3: the label field was missed by the finding-1.14 buffering pass above —
// it still committed on every keystroke.
describe('AnnotationsEditorSection label input (finding 2.3)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('does not commit while typing', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: '' }]);
    const input = screen.getByLabelText('Label') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Target' } });
    expect(input.value).toBe('Target');
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits the typed label once on blur', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: '' }]);
    const input = screen.getByLabelText('Label') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'T' } });
    fireEvent.change(input, { target: { value: 'Ta' } });
    fireEvent.change(input, { target: { value: 'Target' } });
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      annotations: [expect.objectContaining({ id: 'ann-1', label: 'Target' })],
    });
  });

  it('commits once on Enter', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: '' }]);
    const input = screen.getByLabelText('Label') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Goal' } });
    act(() => {
      input.focus();
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      annotations: [expect.objectContaining({ id: 'ann-1', label: 'Goal' })],
    });
  });

  it('does not commit on blur when unchanged', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: 'Existing' }]);
    const input = screen.getByLabelText('Label');
    fireEvent.blur(input);
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });
});

/**
 * M2 — the two buffered annotation inputs resynced on `value` alone. `key={ann.id}` looks
 * like it covers the switch, but `duplicateWidget` clones `config` BY REFERENCE, so a
 * duplicated widget carries identical annotation ids *and* identical values: the key stays
 * the same, the effect stays quiet, and a dirty buffer from the original widget commits
 * onto the duplicate. The inputs now also resync on `identity` (`${widgetId}:${ann.id}`),
 * which changes even when both the id and the value are shared.
 */
describe('AnnotationsEditorSection identity resync (M2)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  const annotations: StudioChartAnnotation[] = [{ id: 'ann-1', axis: 'y', value: 10, label: '' }];

  it('discards a dirty label buffer when the edited widget changes under an identical annotation', () => {
    // `widgetId` is the only thing that differs — same annotation id, same values, exactly
    // the shape `duplicateWidget` produces.
    const { setProps } = render(
      <AnnotationsEditorSection widgetId="widget-1" config={{ annotations }} />,
    );
    const input = screen.getByLabelText('Label') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Target' } });

    setProps({ widgetId: 'widget-2' });

    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('');
    fireEvent.blur(screen.getByLabelText('Label'));
    // Nothing dirty is left, so the original widget's edit cannot land on the duplicate.
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('discards a dirty value buffer the same way', () => {
    const { setProps } = render(
      <AnnotationsEditorSection widgetId="widget-1" config={{ annotations }} />,
    );
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '42' } });

    setProps({ widgetId: 'widget-2' });

    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('10');
    fireEvent.blur(screen.getByLabelText('Value'));
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });
});
// M15: `AnnotationLabelInput` was the ONE buffered input in the drawer with no change-check
// on commit. `dirty` means "was typed in", not "differs from the stored value", so typing a
// character into a reference-line label and deleting it again pushed an undoable commit whose
// content matched its predecessor — and, because every commit clears the redo stack, it also
// silently discarded any redo the user still had. A later Ctrl+Z then appeared to do nothing.
describe('AnnotationsEditorSection label input no-op guard (M15)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('commits nothing when the label is typed and restored before blur', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: 'Goal' }]);
    const input = screen.getByLabelText('Label') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Goals' } });
    fireEvent.change(input, { target: { value: 'Goal' } });
    fireEvent.blur(input);

    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits nothing when a character is typed into an empty label and deleted again', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: '' }]);
    const input = screen.getByLabelText('Label') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('still commits a genuine label change', () => {
    renderAnnotations([{ id: 'ann-1', axis: 'y', value: 10, label: '' }]);
    const input = screen.getByLabelText('Label') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Target' } });
    fireEvent.blur(input);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      annotations: [expect.objectContaining({ id: 'ann-1', label: 'Target' })],
    });
  });
});
