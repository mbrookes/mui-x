import * as React from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { StudioProvider } from '@mui/x-studio';
import type { StudioAIConfig } from '@mui/x-studio';
import { ukRegionsGeography } from './config/geographies/ukRegions';
import { LOCALE_BUNDLES, type SupportedLocale } from './locales';
import { theme } from './theme';
import { AppLayout } from './AppLayout';
import { useChatControllers } from './hooks/useChatControllers';
import { useChatStore } from './hooks/useChatStore';
import { useGenerateChatTitle } from './hooks/useGenerateChatTitle';

const CUSTOM_GEOGRAPHIES = { ukRegions: ukRegionsGeography };
const LOCALE_STORAGE_KEY = 'x-studio-ai-locale';
const DEFAULT_LOCALE: SupportedLocale = 'en';

function readStoredLocale(): SupportedLocale {
  try {
    const locale = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (locale && locale in LOCALE_BUNDLES) {
      return locale as SupportedLocale;
    }
  } catch {
    // Ignore storage errors and fall back to English.
  }

  return DEFAULT_LOCALE;
}

export default function App() {
  const { chats, activeChatId, setActiveChatId, createChat, updateChat } = useChatStore();
  const { getOrCreateController, saveController } = useChatControllers();
  const [locale, setLocale] = React.useState<SupportedLocale>(readStoredLocale);

  const aiConfig = React.useMemo<StudioAIConfig | undefined>(() => {
    const endpoint = import.meta.env.LLM_ENDPOINT as string | undefined;
    if (!endpoint) {
      return undefined;
    }

    return {
      endpoint,
      apiKey: import.meta.env.LLM_API_KEY as string | undefined,
      model: (import.meta.env.LLM_MODEL as string | undefined) ?? 'gpt-4o',
      headers: import.meta.env.LLM_TOKEN as string | undefined
        ? { 'X-Studio-Token': import.meta.env.LLM_TOKEN as string }
        : undefined,
    };
  }, []);

  const { generateTitle } = useGenerateChatTitle(aiConfig);
  const localeBundle = LOCALE_BUNDLES[locale];

  React.useEffect(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  const activeController = React.useMemo(() => {
    if (activeChatId === null) {
      return getOrCreateController('__home__');
    }
    return getOrCreateController(activeChatId);
  }, [activeChatId, getOrCreateController]);

  const handleNewChat = React.useCallback(() => {
    setActiveChatId(null);
  }, [setActiveChatId]);

  const handleHomeSubmit = React.useCallback(
    async (message: string) => {
      const chat = createChat('New Chat', message);
      generateTitle(message).then(({ title, description }) => {
        updateChat(chat.id, { title, description });
      });
    },
    [createChat, generateTitle, updateChat],
  );

  const handleChatSelect = React.useCallback(
    (id: string) => {
      setActiveChatId(id);
    },
    [setActiveChatId],
  );

  return (
    <ThemeProvider theme={theme}>
      <LocalizationProvider
        dateAdapter={AdapterDayjs}
        adapterLocale={localeBundle.dayjsLocale}
        localeText={localeBundle.pickersLocaleText}
      >
        <CssBaseline />
        <StudioProvider
          key={activeChatId ?? '__home__'}
          controller={activeController}
          aiConfig={aiConfig}
          geographies={CUSTOM_GEOGRAPHIES}
          localeText={localeBundle.studioLocaleText}
        >
          <AppLayout
            aiConfig={aiConfig}
            chats={chats}
            activeChatId={activeChatId}
            locale={locale}
            onLocaleChange={setLocale}
            onNewChat={handleNewChat}
            onSubmitHome={handleHomeSubmit}
            onChatSelect={handleChatSelect}
            onUpdateChat={updateChat}
            onSaveController={saveController}
          />
        </StudioProvider>
      </LocalizationProvider>
    </ThemeProvider>
  );
}
