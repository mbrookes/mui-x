import type { StudioDataField } from '../../models';

export type FieldType = StudioDataField['type'];

export type FieldOption = {
  id: string;
  label: string;
  fieldType: FieldType;
  sourceId: string;
  sourceLabel: string;
};

export type SimpleField = { id: string; label: string; fieldType: FieldType };

export type FilterMode = 'condition' | 'selection' | 'rank';
