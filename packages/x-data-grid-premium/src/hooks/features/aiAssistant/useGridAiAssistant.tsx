'use client';
import * as React from 'react';
import type { RefObject } from '@mui/x-internals/types';
import { isDeepEqual } from '@mui/x-internals/isDeepEqual';
import {
  gridColumnLookupSelector,
  GridLogicOperator,
  gridRowsLookupSelector,
  useGridApiMethod,
  GRID_CHECKBOX_SELECTION_FIELD,
  GridPreferencePanelsValue,
  gridColumnGroupsUnwrappedModelSelector,
  gridVisibleRowsSelector,
  gridSortModelSelector,
  gridFilterModelSelector,
  gridRowCountSelector,
  gridFilteredSortedRowIdsSelector,
} from '@mui/x-data-grid-pro';
import type { GridRowSelectionModel, GridSingleSelectColDef } from '@mui/x-data-grid-pro';
import {
  getValueOptions,
  getVisibleRows,
  useGridRegisterPipeProcessor,
  gridPivotActiveSelector,
} from '@mui/x-data-grid-pro/internals';
import type { GridPipeProcessor, GridStateInitializer } from '@mui/x-data-grid-pro/internals';
import type { GridPrivateApiPremium } from '../../../models/gridApiPremium';
import type {
  GridAiAssistantApi,
  GridAiAssistantState,
  Prompt,
  PromptResponse,
  ViewConfigPromptResponse,
  ColumnStatistics,
  NumericColumnStatistics,
  CategoricalColumnStatistics,
  PromptContext,
  PromptContextColumn,
  GridDataQueryInput,
  GridDataQueryResult,
  GridStatisticsInput,
  GridValueDistributionInput,
  GridValueDistributionResult,
} from './gridAiAssistantInterfaces';
import type { DataGridPremiumProcessedProps } from '../../../models/dataGridPremiumProps';
import {
  gridAiAssistantConversationsSelector,
  gridAiAssistantActiveConversationSelector,
  gridAiAssistantActiveConversationIndexSelector,
} from './gridAiAssistantSelectors';
import { gridChartsIntegrationActiveChartIdSelector } from '../chartsIntegration/gridChartsIntegrationSelectors';
import { gridRowGroupingModelSelector } from '../rowGrouping/gridRowGroupingSelector';
import { gridAggregationModelSelector } from '../aggregation/gridAggregationSelectors';

const DEFAULT_SAMPLE_COUNT = 5;
const MAX_CHART_DATA_POINTS = 1000;
/** Maximum number of rows scanned when computing column statistics. */
const MAX_STATS_ROWS = 10_000;

export const aiAssistantStateInitializer: GridStateInitializer<
  Pick<DataGridPremiumProcessedProps, 'initialState' | 'aiAssistantConversations' | 'aiAssistant'>
> = (state, props) => {
  if (!props.aiAssistant) {
    return {
      ...state,
      aiAssistant: {
        activeConversationIndex: 0,
        conversations: [],
      } as GridAiAssistantState,
    };
  }

  return {
    ...state,
    aiAssistant: {
      activeConversationIndex: 0,
      conversations:
        props.aiAssistantConversations ?? props.initialState?.aiAssistant?.conversations ?? [],
    } as GridAiAssistantState,
  };
};

export const useGridAiAssistant = (
  apiRef: RefObject<GridPrivateApiPremium>,
  props: Pick<
    DataGridPremiumProcessedProps,
    | 'aiAssistant'
    | 'aiAssistantConversations'
    | 'aiAssistantActiveConversationIndex'
    | 'allowAiAssistantDataSampling'
    | 'allowAiAssistantStatistics'
    | 'onAiAssistantConversationsChange'
    | 'onAiAssistantActiveConversationIndexChange'
    | 'onPrompt'
    | 'slots'
    | 'rowSelection'
    | 'disableColumnFilter'
    | 'disableRowGrouping'
    | 'disableAggregation'
    | 'disableColumnSorting'
    | 'disablePivoting'
    | 'chartsIntegration'
    | 'getPivotDerivedColumns'
  >,
) => {
  const {
    onPrompt,
    allowAiAssistantDataSampling,
    allowAiAssistantStatistics,
    slots,
    rowSelection,
    disableColumnFilter,
    disableRowGrouping,
    disableAggregation,
    disableColumnSorting,
    disablePivoting,
    chartsIntegration,
    getPivotDerivedColumns,
  } = props;
  const previousUnwrappedGroupingModel = React.useRef<string[]>([]);
  const activeChartId = gridChartsIntegrationActiveChartIdSelector(apiRef);
  const columnsLookup = gridColumnLookupSelector(apiRef);
  const columns = Object.values(columnsLookup);
  const rows = Object.values(gridRowsLookupSelector(apiRef));
  const isAiAssistantAvailable = !!props.aiAssistant;

  apiRef.current.registerControlState({
    stateId: 'aiAssistantConversations',
    propModel: props.aiAssistantConversations,
    propOnChange: props.onAiAssistantConversationsChange,
    stateSelector: gridAiAssistantConversationsSelector,
    changeEvent: 'aiAssistantConversationsChange',
  });

  apiRef.current.registerControlState({
    stateId: 'aiAssistantActiveConversationIndex',
    propModel: props.aiAssistantActiveConversationIndex,
    propOnChange: props.onAiAssistantActiveConversationIndexChange,
    stateSelector: gridAiAssistantActiveConversationIndexSelector,
    changeEvent: 'aiAssistantActiveConversationIndexChange',
  });

  const preferencePanelPreProcessing = React.useCallback<GridPipeProcessor<'preferencePanel'>>(
    (initialValue, value) => {
      if (
        isAiAssistantAvailable &&
        slots.aiAssistantPanel &&
        value === GridPreferencePanelsValue.aiAssistant
      ) {
        return <slots.aiAssistantPanel />;
      }

      return initialValue;
    },
    [isAiAssistantAvailable, slots],
  );

  const collectSampleData = React.useCallback(() => {
    const columnExamples: Record<string, any[]> = {};

    columns.forEach((column) => {
      columnExamples[column.field] = Array.from({
        length: Math.min(DEFAULT_SAMPLE_COUNT, rows.length),
      }).map(() => {
        const row = rows[Math.floor(Math.random() * rows.length)];
        return apiRef.current.getRowValue(row, column);
      });
    });

    return columnExamples;
  }, [apiRef, columns, rows]);

  const computeColumnStatistics = React.useCallback(
    (rowsToScan: object[]): Record<string, ColumnStatistics> => {
      const result: Record<string, ColumnStatistics> = {};

      columns.forEach((column) => {
        const isNumeric =
          column.type === 'number' || column.type === 'date' || column.type === 'dateTime';
        const values: unknown[] = rowsToScan.map((row) => apiRef.current.getRowValue(row, column));
        const nonNullValues = values.filter((v) => v != null);
        const nullCount = values.length - nonNullValues.length;

        if (isNumeric) {
          const nums = nonNullValues
            .map((v) => (v instanceof Date ? v.getTime() : Number(v)))
            .filter((n) => !Number.isNaN(n));

          if (nums.length === 0) {
            result[column.field] = {
              count: values.length,
              nullCount,
              min: 0,
              max: 0,
              avg: 0,
              sum: 0,
            } as NumericColumnStatistics;
          } else {
            let min = nums[0];
            let max = nums[0];
            let sum = 0;
            for (const n of nums) {
              if (n < min) min = n;
              if (n > max) max = n;
              sum += n;
            }
            result[column.field] = {
              count: values.length,
              nullCount,
              min,
              max,
              avg: sum / nums.length,
              sum,
            } as NumericColumnStatistics;
          }
        } else {
          const counts = new Map<unknown, number>();
          for (const v of nonNullValues) {
            counts.set(v, (counts.get(v) ?? 0) + 1);
          }
          const sorted = [...counts.entries()].sort((a, b) => (b[1] as number) - (a[1] as number));
          result[column.field] = {
            count: values.length,
            nullCount,
            uniqueCount: counts.size,
            topValues: sorted.slice(0, 10).map(([value, count]) => ({ value, count })),
          } as CategoricalColumnStatistics;
        }
      });

      return result;
    },
    [apiRef, columns],
  );

  const buildPromptContext = React.useCallback(
    (allowDataSampling = false, includeStatistics = false): PromptContext => {
      const examples = allowDataSampling ? collectSampleData() : {};

      const allRowIds = gridFilteredSortedRowIdsSelector(apiRef);
      const totalRows = gridRowCountSelector(apiRef);
      const visibleRowCount = gridVisibleRowsSelector(apiRef).rows.length;

      // Compute stats over visible (filtered) rows, capped at MAX_STATS_ROWS
      let statistics: Record<string, ColumnStatistics> | null = null;
      let statisticsSampled = false;
      if (includeStatistics) {
        const rowsLookup = gridRowsLookupSelector(apiRef);
        const scanIds =
          allRowIds.length > MAX_STATS_ROWS ? allRowIds.slice(0, MAX_STATS_ROWS) : allRowIds;
        statisticsSampled = scanIds.length < allRowIds.length;
        const rowsToScan = scanIds.map((id) => rowsLookup[id]).filter(Boolean);
        statistics = computeColumnStatistics(rowsToScan);
      }

      const schema: PromptContextColumn[] = columns.reduce((acc, column) => {
        const baseEntry: PromptContextColumn = {
          field: column.field,
          description: column.description ?? null,
          examples: examples[column.field] ?? column.examples ?? [],
          type: column.type ?? 'string',
          allowedOperators: column.filterOperators?.map((operator) => operator.value) ?? [],
          ...(statistics ? { statistics: statistics[column.field] } : {}),
        };

        acc.push(baseEntry);

        if (!disablePivoting) {
          (getPivotDerivedColumns?.(column, apiRef.current.getLocaleText) || []).forEach((col) =>
            acc.push({
              ...baseEntry,
              examples: [],
              ...col,
              derivedFrom: column.field,
            }),
          );
        }

        return acc;
      }, [] as PromptContextColumn[]);

      // Capture active view state so agents know what's currently applied
      const filterModel = gridFilterModelSelector(apiRef);
      const sortModel = gridSortModelSelector(apiRef);
      const groupingModel = gridRowGroupingModelSelector(apiRef);
      const aggregationModel = gridAggregationModelSelector(apiRef);
      const pivotActive = gridPivotActiveSelector(apiRef);
      const selectedRowCount = apiRef.current.getSelectedRows().size;

      return {
        schema,
        rowCount: {
          total: totalRows,
          visible: visibleRowCount,
          ...(statisticsSampled ? { statisticsSampled: true } : {}),
        },
        currentState: {
          filters: filterModel.items.map((item) => ({
            column: item.field,
            operator: item.operator,
            value: item.value as string | number | boolean | string[] | number[],
          })),
          filterOperator: filterModel.logicOperator === GridLogicOperator.Or ? 'or' : 'and',
          sort: sortModel.map((s) => ({ column: s.field, direction: s.sort ?? 'asc' })),
          grouping: groupingModel,
          aggregation: aggregationModel as Record<string, 'avg' | 'sum' | 'min' | 'max' | 'size'>,
          pivotActive: !!pivotActive,
          selectedRowCount,
        },
      };
    },
    [
      apiRef,
      columns,
      collectSampleData,
      computeColumnStatistics,
      getPivotDerivedColumns,
      disablePivoting,
    ],
  );

  const getPromptContext = React.useCallback(
    (allowDataSampling = false) => {
      if (!isAiAssistantAvailable) {
        return '';
      }
      return JSON.stringify(buildPromptContext(allowDataSampling, allowAiAssistantStatistics));
    },
    [isAiAssistantAvailable, buildPromptContext, allowAiAssistantStatistics],
  );

  const updateChart = React.useCallback(
    (result: ViewConfigPromptResponse) => {
      if (!result.chart) {
        return;
      }

      apiRef.current.updateChartDimensionsData(
        activeChartId,
        result.chart.dimensions.map((item) => ({ field: item })),
      );
      apiRef.current.updateChartValuesData(
        activeChartId,
        result.chart.values.map((item) => ({ field: item })),
      );
    },
    [apiRef, activeChartId],
  );

  const applyPromptResult = React.useCallback(
    (result: PromptResponse) => {
      if (!isAiAssistantAvailable) {
        return;
      }

      // Text and data responses don't modify the grid view
      if (result.type === 'text' || result.type === 'data') {
        return;
      }

      const interestColumns = [] as string[];

      if (!disableColumnFilter) {
        apiRef.current.setFilterModel({
          items: result.filters.map((filter, index) => {
            const item = {
              id: index,
              field: filter.column,
              operator: filter.operator,
              value: filter.value,
            };

            const column = columnsLookup[filter.column];
            if (column.type === 'singleSelect') {
              const options = getValueOptions(column as GridSingleSelectColDef) ?? [];
              const found = options.find(
                (option) => typeof option === 'object' && option.label === filter.value,
              );
              if (found) {
                item.value = (found as any).value;
              }
            }

            return item;
          }),
          logicOperator: (result.filterOperator as GridLogicOperator) ?? GridLogicOperator.And,
          quickFilterValues: [],
        });
        interestColumns.push(...result.filters.map((f) => f.column));
      } else {
        result.filters = [];
      }

      let appliedPivoting = false;
      if (!disablePivoting && 'columns' in result.pivoting) {
        apiRef.current.setPivotActive(true);
        apiRef.current.setPivotModel({
          columns: result.pivoting.columns.map((c) => ({ field: c.column, sort: c.direction })),
          rows: result.pivoting.rows.map((r) => ({ field: r })),
          values: result.pivoting.values.map((valueObj) => {
            const [field] = Object.keys(valueObj);
            return { field, aggFunc: valueObj[field] };
          }),
        });
        appliedPivoting = true;
      } else if ('columns' in result.pivoting) {
        // if pivoting is disabled and there are pivoting results, try to move them into grouping and aggregation
        apiRef.current.setPivotActive(false);
        result.pivoting.columns.forEach((c) => {
          result.grouping.push({ column: c.column });
        });
        result.pivoting.rows.forEach((r) => {
          result.grouping.push({ column: r });
        });
        result.pivoting.values.forEach((valueObj) => {
          const [field] = Object.keys(valueObj);
          result.aggregation[field] = valueObj[field];
        });
        // remove the pivoting results data
        result.pivoting = {};
      } else {
        apiRef.current.setPivotActive(false);
      }

      if (!disableRowGrouping && !appliedPivoting) {
        apiRef.current.setRowGroupingModel(result.grouping.map((g) => g.column));
      } else {
        result.grouping = [];
      }

      if (!disableAggregation && !appliedPivoting) {
        apiRef.current.setAggregationModel(result.aggregation);
        interestColumns.push(...Object.keys(result.aggregation));
      } else {
        result.aggregation = {};
      }

      if (!disableColumnSorting) {
        apiRef.current.setSortModel(
          result.sorting.map((s) => ({ field: s.column, sort: s.direction })),
        );
      } else {
        result.sorting = [];
      }

      if (chartsIntegration && activeChartId && result.chart) {
        if (appliedPivoting) {
          const unsubscribe = apiRef.current.subscribeEvent('rowsSet', () => {
            const unwrappedGroupingModel = Object.keys(
              gridColumnGroupsUnwrappedModelSelector(apiRef),
            );
            // wait until unwrapped grouping model changes
            if (
              !result.chart ||
              unwrappedGroupingModel.length === 0 ||
              isDeepEqual(previousUnwrappedGroupingModel.current, unwrappedGroupingModel)
            ) {
              return;
            }

            previousUnwrappedGroupingModel.current = unwrappedGroupingModel;

            const visibleRowsCount = gridVisibleRowsSelector(apiRef).rows.length;
            const maxColumns = Math.floor(MAX_CHART_DATA_POINTS / visibleRowsCount);

            // we assume that the pivoting was adjusted to what needs to be shown in the chart
            // so we can just pick up all the columns that were created by pivoting
            // to avoid rendering issues, set the limit to MAX_CHART_DATA_POINTS data points (rows * columns)
            result.chart.values = unwrappedGroupingModel.slice(0, maxColumns);
            updateChart(result);

            unsubscribe();
          });
        } else {
          updateChart(result);
        }
      }

      const visibleRowsData = getVisibleRows(apiRef);
      const rowSelectionModel: GridRowSelectionModel = { type: 'include', ids: new Set() };
      const selection = rowSelection ? result.select : -1;
      if (selection !== -1) {
        for (let i = 0; i < result.select; i += 1) {
          const row = visibleRowsData.rows[i];
          const id = apiRef.current.getRowId(row);
          rowSelectionModel.ids.add(id);
        }
      }

      apiRef.current.setRowSelectionModel(rowSelectionModel);

      const targetIndex =
        Number(columnsLookup[GRID_CHECKBOX_SELECTION_FIELD] !== undefined) +
        Number(result.grouping.length);

      interestColumns.reverse().forEach((c) => apiRef.current.setColumnIndex(c, targetIndex));
    },
    [
      apiRef,
      updateChart,
      rowSelection,
      disableColumnFilter,
      disableRowGrouping,
      disableAggregation,
      disableColumnSorting,
      disablePivoting,
      columnsLookup,
      isAiAssistantAvailable,
      activeChartId,
      chartsIntegration,
    ],
  );

  const setActiveConversationId = React.useCallback(
    (id: string) => {
      if (!isAiAssistantAvailable) {
        return;
      }

      const conversations = gridAiAssistantConversationsSelector(apiRef);
      const activeConversationIndex = gridAiAssistantActiveConversationIndexSelector(apiRef);

      if (!conversations[activeConversationIndex]) {
        return;
      }

      conversations[activeConversationIndex].id = id;

      apiRef.current.setState((state) => ({
        ...state,
        aiAssistant: {
          ...state.aiAssistant,
          conversations,
        },
      }));
    },
    [apiRef, isAiAssistantAvailable],
  );

  const setConversationPrompts = React.useCallback(
    (index: number, callback: (prevPrompts: Prompt[]) => Prompt[]) => {
      if (!isAiAssistantAvailable) {
        return;
      }

      const currentConversations = gridAiAssistantConversationsSelector(apiRef);
      const targetConversation = currentConversations[index];

      const newPrompts =
        typeof callback === 'function'
          ? callback(targetConversation === undefined ? [] : targetConversation.prompts)
          : callback;

      const newConversations = currentConversations.toSpliced(
        targetConversation === undefined ? currentConversations.length : index,
        1,
        {
          ...targetConversation,
          title: newPrompts[newPrompts.length - 1].value, // TODO: make the title configurable
          prompts: newPrompts,
        },
      );

      apiRef.current.setState((state) => ({
        ...state,
        aiAssistant: {
          ...state.aiAssistant,
          conversations: newConversations,
        },
      }));
    },
    [apiRef, isAiAssistantAvailable],
  );

  const processPrompt = React.useCallback(
    async (value: string) => {
      if (!onPrompt) {
        return undefined;
      }

      const activeConversationIndex = gridAiAssistantActiveConversationIndexSelector(apiRef);
      const activeConversation = gridAiAssistantActiveConversationSelector(apiRef);
      const date = Date.now();

      apiRef.current.setLoading(true);
      setConversationPrompts(activeConversationIndex, (prevPrompts) => [
        ...prevPrompts,
        {
          value,
          createdAt: new Date(date),
          variant: 'processing',
          helperText: apiRef.current.getLocaleText('promptProcessing'),
        },
      ]);
      try {
        const response = await onPrompt(
          value,
          getPromptContext(allowAiAssistantDataSampling),
          activeConversation?.id,
        );
        applyPromptResult(response);
        setActiveConversationId(response.conversationId);
        setConversationPrompts(activeConversationIndex, (prevPrompts) =>
          prevPrompts.map((item) =>
            item.createdAt.getTime() === date
              ? {
                  ...item,
                  response,
                  variant: 'success',
                  helperText: '',
                }
              : item,
          ),
        );
        return response;
      } catch (error: any) {
        setConversationPrompts(activeConversationIndex, (prevPrompts) =>
          prevPrompts.map((item) =>
            item.createdAt.getTime() === date
              ? {
                  ...item,
                  variant: 'error',
                  helperText: error.message,
                }
              : item,
          ),
        );
        return error;
      } finally {
        apiRef.current.setLoading(false);
      }
    },
    [
      apiRef,
      allowAiAssistantDataSampling,
      onPrompt,
      getPromptContext,
      applyPromptResult,
      setConversationPrompts,
      setActiveConversationId,
    ],
  );

  const setActiveConversationIndex = React.useCallback<
    GridAiAssistantApi['aiAssistant']['setActiveConversationIndex']
  >(
    (index) => {
      apiRef.current.setState((state) => ({
        ...state,
        aiAssistant: {
          ...state.aiAssistant,
          activeConversationIndex: index,
        },
      }));

      const conversation = gridAiAssistantActiveConversationSelector(apiRef);
      if (!conversation) {
        throw new Error('MUI X: Conversation not found');
      }
      return conversation;
    },
    [apiRef],
  );

  const setConversations = React.useCallback<GridAiAssistantApi['aiAssistant']['setConversations']>(
    (callback) => {
      if (!isAiAssistantAvailable) {
        return;
      }

      apiRef.current.setState((state) => ({
        ...state,
        aiAssistant: {
          ...state.aiAssistant,
          conversations:
            typeof callback === 'function' ? callback(state.aiAssistant?.conversations) : callback,
        },
      }));
    },
    [apiRef, isAiAssistantAvailable],
  );

  const getContext = React.useCallback<GridAiAssistantApi['aiAssistant']['getContext']>(
    (includeStatistics = false) => {
      return buildPromptContext(false, includeStatistics);
    },
    [buildPromptContext],
  );

  const queryRows = React.useCallback<GridAiAssistantApi['aiAssistant']['queryRows']>(
    (input?: GridDataQueryInput): GridDataQueryResult => {
      const { fields, limit = 100, offset = 0 } = input ?? {};
      const allRowIds = gridFilteredSortedRowIdsSelector(apiRef);
      const rowsLookup = gridRowsLookupSelector(apiRef);
      const slicedIds = allRowIds.slice(offset, offset + limit);

      const rows = slicedIds.map((id) => {
        const row = rowsLookup[id];
        if (!fields) {
          // Return values via getRowValue for consistent formatting
          const entry: Record<string, unknown> = {};
          columns.forEach((column) => {
            entry[column.field] = apiRef.current.getRowValue(row, column);
          });
          return entry;
        }
        const entry: Record<string, unknown> = {};
        fields.forEach((field) => {
          const column = columnsLookup[field];
          if (column) {
            entry[field] = apiRef.current.getRowValue(row, column);
          }
        });
        return entry;
      });

      return {
        rows,
        totalCount: allRowIds.length,
        hasMore: offset + limit < allRowIds.length,
      };
    },
    [apiRef, columns, columnsLookup],
  );

  const getStatistics = React.useCallback<GridAiAssistantApi['aiAssistant']['getStatistics']>(
    (input?: GridStatisticsInput): Record<string, ColumnStatistics> => {
      const allRowIds = gridFilteredSortedRowIdsSelector(apiRef);
      const rowsLookup = gridRowsLookupSelector(apiRef);
      const scanIds =
        allRowIds.length > MAX_STATS_ROWS ? allRowIds.slice(0, MAX_STATS_ROWS) : allRowIds;
      const rowsToScan = scanIds.map((id) => rowsLookup[id]).filter(Boolean);

      const allStats = computeColumnStatistics(rowsToScan);

      if (!input?.fields) {
        return allStats;
      }
      const filtered: Record<string, ColumnStatistics> = {};
      input.fields.forEach((field) => {
        if (allStats[field] !== undefined) {
          filtered[field] = allStats[field];
        }
      });
      return filtered;
    },
    [apiRef, computeColumnStatistics],
  );

  const getValueDistribution = React.useCallback<
    GridAiAssistantApi['aiAssistant']['getValueDistribution']
  >(
    (input: GridValueDistributionInput): GridValueDistributionResult => {
      const { field, limit: topLimit = 20 } = input;
      const column = columnsLookup[field];
      const allRowIds = gridFilteredSortedRowIdsSelector(apiRef);
      const rowsLookup = gridRowsLookupSelector(apiRef);

      const counts = new Map<unknown, number>();
      let nullCount = 0;
      let totalCount = 0;

      for (const id of allRowIds) {
        const row = rowsLookup[id];
        if (!row) continue;
        const value = column ? apiRef.current.getRowValue(row, column) : (row as any)[field];
        totalCount += 1;
        if (value == null) {
          nullCount += 1;
        } else {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }

      const sorted = [...counts.entries()].sort((a, b) => (b[1] as number) - (a[1] as number));

      return {
        field,
        values: sorted.slice(0, topLimit).map(([value, count]) => ({ value, count })),
        totalCount,
        nullCount,
        uniqueCount: counts.size,
      };
    },
    [apiRef, columnsLookup],
  );

  React.useEffect(() => {
    if (props.aiAssistantConversations) {
      setConversations(props.aiAssistantConversations);
    }
  }, [apiRef, props.aiAssistantConversations, setConversations]);

  React.useEffect(() => {
    if (props.aiAssistantActiveConversationIndex) {
      setActiveConversationIndex(props.aiAssistantActiveConversationIndex);
    }
  }, [apiRef, props.aiAssistantActiveConversationIndex, setActiveConversationIndex]);

  useGridRegisterPipeProcessor(apiRef, 'preferencePanel', preferencePanelPreProcessing);
  useGridApiMethod(
    apiRef,
    {
      aiAssistant: {
        processPrompt,
        setConversations,
        setActiveConversationIndex,
        getContext,
        queryRows,
        getStatistics,
        getValueDistribution,
      },
    },
    'public',
  );
};
