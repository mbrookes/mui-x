'use client';
import * as React from 'react';
import { Alert, Stack, Typography } from '@mui/material';

import {
  CanvasScrollContext,
  useStudioController,
  useStudioSelector,
  useCustomWidgetMap,
  selectDataSources,
  useStudioLocaleText,
} from '../../context';
import {
  createDefaultWidget,
  WIDGET_TYPES,
  widgetKindRequiresDataSource,
} from '../../internals/widgetUtils';
import type { StudioWidgetKind } from '../../models';
import { getBuiltInWidgetKindInfo } from './StudioComposeDrawerLabels';
import { useStudioFeatures, useStudioUIConfig } from '../../internals/StudioUIConfigContext';
import { DescribeWidgetSection } from './DescribeWidgetSection';
import { WidgetTypeCard } from './WidgetTypeCard';
import type { WidgetTypeEntry } from './WidgetTypeCard';
import { WidgetInstanceList } from './WidgetInstanceList';

/**
 * Smoothly scrolls a container to its bottom over `duration` ms using ease-out cubic.
 * The target is re-evaluated each frame so the animation tracks content that loads
 * asynchronously (e.g. widget card content rendered via useTransition).
 */
function smoothScrollToBottom(container: HTMLElement, duration = 420) {
  const startY = container.scrollTop;
  const startTime = performance.now();
  function easeOutCubic(t: number): number {
    return 1 - (1 - t) ** 3;
  }
  function step(now: number) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Re-read bottom each frame — widget content may still be loading
    const targetY = container.scrollHeight - container.clientHeight;
    container.scrollTop = startY + (targetY - startY) * easeOutCubic(progress);
    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      // Final snap: catches any content that finished loading after the animation
      container.scrollTop = container.scrollHeight - container.clientHeight;
    }
  }
  requestAnimationFrame(step);
}

export function AddWidgetView() {
  const controller = useStudioController();
  const dataSources = useStudioSelector(selectDataSources);
  const features = useStudioFeatures();
  useStudioUIConfig();
  const localeText = useStudioLocaleText();
  const canvasScrollRef = React.use(CanvasScrollContext);
  const customWidgetMap = useCustomWidgetMap();
  const [selectedKind, setSelectedKind] = React.useState<StudioWidgetKind | null>(null);

  const scrollToBottom = React.useCallback(() => {
    // Double-rAF: first waits for React to commit the new card, second for the
    // browser to complete layout — so scrollHeight reflects the new widget height.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = canvasScrollRef?.current;
        if (container) {
          smoothScrollToBottom(container);
        }
      });
    });
  }, [canvasScrollRef]);

  const handleAdd = React.useCallback(
    (kind: StudioWidgetKind) => {
      const sources = Object.values(dataSources).filter((s) => !s.hidden);
      const customDef = customWidgetMap.get(kind);
      const requiresSource = customDef
        ? (customDef.requiresDataSource ?? false)
        : widgetKindRequiresDataSource(kind);
      if (requiresSource && sources.length === 0) {
        return;
      }
      if (customDef) {
        controller.addWidget(
          createDefaultWidget(kind, {
            title: customDef.label ?? kind,
            customConfig: customDef.defaultConfig ?? {},
          }),
        );
      } else {
        controller.addWidget(createDefaultWidget(kind));
      }
      scrollToBottom();
    },
    [controller, customWidgetMap, dataSources, scrollToBottom],
  );

  const handleSelectKind = React.useCallback((kind: StudioWidgetKind) => {
    setSelectedKind(kind);
  }, []);

  const hasSources = Object.values(dataSources).some((s) => !s.hidden);

  // Combine built-in widget types with consumer-registered custom widget types
  const allWidgetTypes = React.useMemo<WidgetTypeEntry[]>(() => {
    const kindInfo = getBuiltInWidgetKindInfo(localeText);
    const builtins = WIDGET_TYPES.flatMap((wt) => {
      const include = (() => {
        switch (wt.kind) {
          case 'grid':
            return features.grid !== false;
          case 'chart':
            return features.chart !== false;
          case 'kpi':
            return features.kpi !== false;
          case 'text':
            return features.text !== false;
          case 'filter':
            return features.filter !== false;
          case 'pivot':
            return features.pivot !== false;
          case 'map':
            return features.map !== false;
          default:
            return true;
        }
      })();
      return include ? [{ ...wt, ...(kindInfo[wt.kind] ?? {}) }] : [];
    });
    const customs = Array.from(customWidgetMap.values()).map((def) => ({
      kind: def.kind,
      label: def.label ?? def.kind,
      description: def.description ?? localeText.composeCustomWidgetDescription,
      icon: def.icon ?? null,
    }));
    return [...builtins, ...customs];
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- localeText is stable
  }, [features, customWidgetMap, localeText]);

  if (selectedKind) {
    return (
      <WidgetInstanceList
        kind={selectedKind}
        onBack={() => setSelectedKind(null)}
        onAdd={(kind) => {
          handleAdd(kind);
          setSelectedKind(null);
        }}
      />
    );
  }

  return (
    <Stack spacing={1.5}>
      <DescribeWidgetSection onCreated={scrollToBottom} />
      <Typography variant="caption" color="text.secondary">
        {localeText.composeChooseWidgetType}
      </Typography>
      {!hasSources && (
        <Alert severity="warning" sx={{ fontSize: 12 }}>
          {localeText.composeNoDataSources}
        </Alert>
      )}
      {allWidgetTypes.map((wt) => {
        const customDef = customWidgetMap.get(wt.kind);
        const requiresSource = customDef
          ? (customDef.requiresDataSource ?? false)
          : widgetKindRequiresDataSource(wt.kind);
        const canAdd = !requiresSource || hasSources;
        return <WidgetTypeCard key={wt.kind} wt={wt} canAdd={canAdd} onSelect={handleSelectKind} />;
      })}
    </Stack>
  );
}
