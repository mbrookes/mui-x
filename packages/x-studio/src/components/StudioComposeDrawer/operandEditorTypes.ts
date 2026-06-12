export interface FieldOption {
  id: string;
  label: string;
}

export type OperandType = 'field' | 'const';

export interface OperandState {
  type: OperandType;
  fieldId: string;
  constant: string;
}

export function defaultOperand(fallbackFieldId?: string): OperandState {
  return { type: 'field', fieldId: fallbackFieldId ?? '', constant: '' };
}
