import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
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
