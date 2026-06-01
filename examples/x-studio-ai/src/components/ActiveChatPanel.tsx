import * as React from 'react';
import { Box, IconButton, TextField, Tooltip, Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { StudioChatPanel } from '@mui/x-studio';
import type { StudioAIConfig } from '@mui/x-studio';
import type { ChatSession } from '../hooks/useChatStore';

export const CHAT_PANEL_WIDTH = 380;

const MESSAGES_STORAGE_PREFIX = 'x-studio-ai-messages-';

function readPersistedMessages(chatId: string): unknown[] {
  try {
    return JSON.parse(localStorage.getItem(`${MESSAGES_STORAGE_PREFIX}${chatId}`) ?? '[]');
  } catch {
    return [];
  }
}

interface ActiveChatPanelProps {
  chat: ChatSession;
  aiConfig: StudioAIConfig | undefined;
  onUpdateChat: (id: string, update: Partial<ChatSession>) => void;
  focusedWidgetId?: string | null;
}

export function ActiveChatPanel({
  chat,
  aiConfig,
  onUpdateChat,
  focusedWidgetId,
}: ActiveChatPanelProps) {
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState(chat.title);

  // Restore persisted messages on mount; memoised so it's only read once per chatId mount.
  const initialMessages = React.useMemo(() => readPersistedMessages(chat.id), [chat.id]);

  // Clear the pending message from the store after it has been seeded into the composer.
  React.useEffect(() => {
    if (chat.pendingMessage) {
      onUpdateChat(chat.id, { pendingMessage: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    setTitleDraft(chat.title);
  }, [chat.title]);

  const handleTitleCommit = React.useCallback(() => {
    if (titleDraft.trim()) {
      onUpdateChat(chat.id, { title: titleDraft.trim() });
    }
    setEditingTitle(false);
  }, [chat.id, onUpdateChat, titleDraft]);

  const handleMessagesChange = React.useCallback(
    (messages: unknown[]) => {
      try {
        localStorage.setItem(
          `${MESSAGES_STORAGE_PREFIX}${chat.id}`,
          JSON.stringify(messages),
        );
      } catch {
        // Ignore storage errors (e.g. quota exceeded).
      }
    },
    [chat.id],
  );

  return (
    <Box
      sx={{
        width: CHAT_PANEL_WIDTH,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1.5,
          py: 0.75,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
          minHeight: 44,
        }}
      >
        {editingTitle ? (
          <TextField
            autoFocus
            size="small"
            value={titleDraft}
            fullWidth
            variant="standard"
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={handleTitleCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                handleTitleCommit();
              }
              if (event.key === 'Escape') {
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <>
            <Typography
              variant="subtitle2"
              sx={{
                flexGrow: 1,
                cursor: 'text',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: 600,
              }}
              onClick={() => {
                setTitleDraft(chat.title);
                setEditingTitle(true);
              }}
              title={chat.title}
            >
              {chat.title}
            </Typography>
            <Tooltip title="Rename">
              <IconButton
                size="small"
                onClick={() => {
                  setTitleDraft(chat.title);
                  setEditingTitle(true);
                }}
              >
                <EditIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title={chat.isFavorite ? 'Remove from favorites' : 'Add to favorites'}>
              <IconButton
                size="small"
                onClick={() => onUpdateChat(chat.id, { isFavorite: !chat.isFavorite })}
              >
                {chat.isFavorite ? (
                  <StarIcon sx={{ fontSize: 14 }} color="warning" />
                ) : (
                  <StarBorderIcon sx={{ fontSize: 14 }} />
                )}
              </IconButton>
            </Tooltip>
          </>
        )}
      </Box>

      {chat.description && !editingTitle && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            px: 1.5,
            py: 0.5,
            display: 'block',
            borderBottom: 1,
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          {chat.description}
        </Typography>
      )}

      <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
        {aiConfig ? (
          <StudioChatPanel
            aiConfig={aiConfig}
            {...(focusedWidgetId ? { focusedWidgetId } : {})}
            slotProps={{
              chatBox: {
                initialMessages,
                onMessagesChange: handleMessagesChange,
                ...(chat.pendingMessage
                  ? { initialComposerValue: chat.pendingMessage }
                  : {}),
              },
            }}
          />
        ) : (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              AI is not configured. Set LLM_ENDPOINT in your .env.local file.
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
