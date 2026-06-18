import * as React from 'react';
import { Box } from '@mui/material';
import { useStudioController, useStudioKeyboardShortcuts } from '@mui/x-studio';
import type { StudioAIConfig } from '@mui/x-studio';
import { downloadJson, uploadJson } from 'x-studio-shared';
import type { SupportedLocale } from './locales';
import { TopNavBar } from './components/TopNavBar';
import { LeftNavBar } from './components/LeftNavBar';
import { ChatHomePanel } from './components/ChatHomePanel';
import { ActiveChatPanel } from './components/ActiveChatPanel';
import { DashboardPane } from './components/DashboardPane';
import { ChatSearchDialog } from './components/ChatSearchDialog';
import { SettingsDialog } from './components/SettingsDialog';
import type { ChatSession } from './hooks/useChatStore';

interface AppLayoutProps {
  aiConfig: StudioAIConfig | undefined;
  chats: ChatSession[];
  activeChatId: string | null;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
  onNewChat: () => void;
  onSubmitHome: (message: string) => void;
  onChatSelect: (id: string) => void;
  onUpdateChat: (id: string, update: Partial<ChatSession>) => void;
  onSaveController: (chatId: string) => void;
}

export function AppLayout({
  aiConfig,
  chats,
  activeChatId,
  locale,
  onLocaleChange,
  onNewChat,
  onSubmitHome,
  onChatSelect,
  onUpdateChat,
  onSaveController,
}: AppLayoutProps) {
  const controller = useStudioController();
  useStudioKeyboardShortcuts();

  const [searchOpen, setSearchOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [focusedWidgetId, setFocusedWidgetId] = React.useState<string | null>(null);

  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  React.useEffect(() => {
    if (!activeChatId) {
      return undefined;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = controller.subscribe(() => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        onSaveController(activeChatId);
      }, 300);
    });

    return () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      onSaveController(activeChatId);
      unsubscribe();
    };
  }, [activeChatId, controller, onSaveController]);

  const handleSave = React.useCallback(() => {
    if (!activeChatId) {
      return;
    }

    onSaveController(activeChatId);
    const serialized = controller.serializeState();
    downloadJson(serialized, `dashboard-${activeChatId}.json`);
    const serverUrl = import.meta.env.STUDIO_SERVER_URL as string | undefined;
    if (serverUrl) {
      const token = import.meta.env.STUDIO_SERVER_TOKEN as string | undefined;
      fetch(`${serverUrl.replace(/\/$/, '')}/api/dashboard-state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(serialized),
      }).catch(() => {});
    }
  }, [activeChatId, controller, onSaveController]);

  const handleLoad = React.useCallback(async () => {
    if (!activeChatId) {
      return;
    }

    try {
      const data = await uploadJson();
      const migrationResult = controller.loadSerializedState(data);
      if (migrationResult.success) {
        setFocusedWidgetId(null);
        onSaveController(activeChatId);
      }
    } catch {
      // Ignore canceled uploads.
    }
  }, [activeChatId, controller, onSaveController]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <TopNavBar
        chatId={activeChatId}
        onSettingsOpen={() => setSettingsOpen(true)}
        onSave={handleSave}
        onLoad={handleLoad}
      />

      <Box sx={{ flexGrow: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {activeChatId !== null && (
          <LeftNavBar
            chats={chats}
            activeChatId={activeChatId}
            onNewChat={onNewChat}
            onChatSelect={(id) => {
              setFocusedWidgetId(null);
              onChatSelect(id);
            }}
            onSearch={() => setSearchOpen(true)}
          />
        )}

        <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
          {activeChatId === null ? (
            <ChatHomePanel onSubmit={onSubmitHome} />
          ) : (
            <Box sx={{ display: 'flex', width: '100%', height: '100%' }}>
              {activeChat && (
                <ActiveChatPanel
                  key={activeChat.id}
                  chat={activeChat}
                  aiConfig={aiConfig}
                  onUpdateChat={onUpdateChat}
                  focusedWidgetId={focusedWidgetId}
                />
              )}
              <DashboardPane onWidgetAiRequest={setFocusedWidgetId} />
            </Box>
          )}
        </Box>
      </Box>

      <ChatSearchDialog
        key={String(searchOpen)}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        chats={chats}
        onSelect={(id) => {
          setFocusedWidgetId(null);
          onChatSelect(id);
          setSearchOpen(false);
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        locale={locale}
        onLocaleChange={onLocaleChange}
      />
    </Box>
  );
}
