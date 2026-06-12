import * as React from 'react';

export interface ChatSession {
  id: string;
  title: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  isFavorite?: boolean;
  /** Ephemeral: first message from the home page, forwarded to the chat panel on mount. */
  pendingMessage?: string;
}

const STORAGE_KEY = 'x-studio-ai-chats';

function readStoredChats(): ChatSession[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as ChatSession[];
  } catch {
    return [];
  }
}

export function useChatStore() {
  const [chats, setChats] = React.useState<ChatSession[]>(readStoredChats);
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);

  const createChat = React.useCallback(
    (title = 'New Chat', pendingMessage?: string): ChatSession => {
      const now = Date.now();
      const session: ChatSession = {
        id: crypto.randomUUID(),
        title,
        createdAt: now,
        updatedAt: now,
        ...(pendingMessage ? { pendingMessage } : {}),
      };

      setChats((prev) => [session, ...prev]);
      setActiveChatId(session.id);
      return session;
    },
    [],
  );

  const updateChat = React.useCallback((id: string, update: Partial<ChatSession>) => {
    setChats((prev) =>
      prev.map((chat) => (chat.id === id ? { ...chat, ...update, updatedAt: Date.now() } : chat)),
    );
  }, []);

  const deleteChat = React.useCallback((id: string) => {
    setChats((prev) => prev.filter((chat) => chat.id !== id));
    setActiveChatId((prev) => (prev === id ? null : prev));
  }, []);

  React.useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  }, [chats]);

  return { chats, activeChatId, setActiveChatId, createChat, updateChat, deleteChat };
}
