'use client';
import * as React from 'react';

interface PieHighlightContextValue {
  ratioByIndex: Map<number, number>;
  isActive: boolean;
  skipAnimation: boolean;
}

export const PieHighlightContext = React.createContext<PieHighlightContextValue>({
  ratioByIndex: new Map(),
  isActive: false,
  skipAnimation: false,
});
