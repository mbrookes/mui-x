import type { StudioExpressionField, StudioRelationship, StudioDataField } from '@mui/x-studio';

export declare const expressions: StudioExpressionField[];
export declare const relationships: StudioRelationship[];
export declare const customersFields: StudioDataField[];
export declare const ordersFields: StudioDataField[];
export declare const orderItemsFields: StudioDataField[];
export declare const productsFields: StudioDataField[];
export declare const shipmentsFields: StudioDataField[];
export declare function getMainDemoData(): unknown;
export declare function getMainDemoDataGenerated(seed: unknown): {
  sources: Array<{ id: string; [key: string]: unknown }>;
};
