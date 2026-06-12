/**
 * Maps `StateMutation` objects (received from the x-studio-ai-middleware SSE stream)
 * to the corresponding `StudioController` method calls.
 */
import type { StudioController } from '../../store/StudioController';
import type { StateMutation } from '../../models';

/**
 * Applies a single `StateMutation` to the local `StudioController`.
 *
 * Called by the thin client adapter whenever a `state-mutation` SSE event arrives.
 */
export function applyStateMutation(mutation: StateMutation, controller: StudioController): void {
  switch (mutation.type) {
    case 'addPage': {
      // The server already chose the page ID; we need to set state directly
      // so IDs match the conversation history held by the server.
      const state = controller.getState();
      controller.setState({
        ...state,
        pages: {
          ...state.pages,
          [mutation.args.id]: { id: mutation.args.id, title: mutation.args.title, widgetRows: [] },
        },
        dashboard: { ...state.dashboard, activePageId: mutation.args.id },
      });
      break;
    }

    case 'setDashboardTitle': {
      controller.setDashboardTitle(mutation.args.title);
      break;
    }

    case 'addWidget': {
      controller.addWidget(mutation.args.widget);
      break;
    }

    case 'updateWidget': {
      const { widgetId, changes, config } = mutation.args;
      if (config !== undefined) {
        controller.updateWidgetConfig(widgetId, config);
      }
      if (changes && Object.keys(changes).length > 0) {
        controller.updateWidget(widgetId, changes);
      }
      break;
    }

    case 'removeWidget': {
      controller.removeWidget(mutation.args.widgetId);
      break;
    }

    case 'setWidgetLayout': {
      controller.setWidgetLayout(mutation.args.rows);
      break;
    }

    case 'setWidgetColSpan': {
      controller.setWidgetColSpanInRow(
        mutation.args.widgetId,
        mutation.args.columns,
        mutation.args.rowWidgetIds,
      );
      break;
    }

    case 'renamePage': {
      controller.renamePage(mutation.args.pageId, mutation.args.title);
      break;
    }

    case 'removePage': {
      controller.removePage(mutation.args.pageId);
      break;
    }

    case 'setActivePage': {
      controller.setActivePage(mutation.args.pageId);
      break;
    }

    case 'addFilter': {
      controller.addFilter(mutation.args.filter);
      break;
    }

    case 'removeFilter': {
      controller.removeFilter(mutation.args.filterId);
      break;
    }

    case 'applyBulkUpdate': {
      const state = controller.getState();
      const { widgets, widgetRows, widgetColSpans, activePageId } = mutation.args;
      const activePage = state.pages[activePageId];
      if (!activePage) break;
      controller.setState({
        ...state,
        widgets,
        pages: {
          ...state.pages,
          [activePageId]: { ...activePage, widgetRows, widgetColSpans },
        },
      });
      break;
    }

    default: {
      // Exhaustiveness check — TypeScript will warn if a new mutation type is added
      // without updating this function.
      console.warn(
        '[StudioChatAdapter] Unknown state mutation type:',
        (mutation as { type: string }).type,
      );
    }
  }
}
