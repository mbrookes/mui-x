import * as React from 'react';
import {
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Popover,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import HistoryIcon from '@mui/icons-material/History';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import type { ChatSession } from '../hooks/useChatStore';

const NAV_WIDTH = 48;

interface LeftNavBarProps {
  chats: ChatSession[];
  activeChatId: string | null;
  onNewChat: () => void;
  onChatSelect: (id: string) => void;
  onSearch: () => void;
}

interface ChatListPopoverProps {
  anchorEl: HTMLElement | null;
  title: string;
  chats: ChatSession[];
  activeChatId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  emptyText?: string;
}

function ChatListPopover({
  anchorEl,
  title,
  chats,
  activeChatId,
  onSelect,
  onClose,
  emptyText,
}: ChatListPopoverProps) {
  return (
    <Popover
      open={Boolean(anchorEl)}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{ paper: { sx: { width: 240, maxHeight: 320, overflow: 'auto', p: 0.5 } } }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ px: 1.5, py: 0.5, display: 'block' }}
      >
        {title}
      </Typography>
      {chats.length === 0 ? (
        <Typography variant="body2" sx={{ p: 1.5, color: 'text.secondary' }}>
          {emptyText ?? 'No chats yet'}
        </Typography>
      ) : (
        <List dense disablePadding>
          {chats.map((chat) => (
            <ListItemButton
              key={chat.id}
              selected={chat.id === activeChatId}
              onClick={() => {
                onSelect(chat.id);
                onClose();
              }}
              sx={{ borderRadius: 1, mx: 0.5 }}
            >
              <ListItemText
                primary={chat.title}
                slotProps={{ primary: { noWrap: true, sx: { fontSize: '0.8125rem' } } }}
              />
            </ListItemButton>
          ))}
        </List>
      )}
    </Popover>
  );
}

export function LeftNavBar({
  chats,
  activeChatId,
  onNewChat,
  onChatSelect,
  onSearch,
}: LeftNavBarProps) {
  const [recentAnchor, setRecentAnchor] = React.useState<HTMLElement | null>(null);
  const [favoritesAnchor, setFavoritesAnchor] = React.useState<HTMLElement | null>(null);

  const recentChats = chats.slice(0, 20);
  const favoriteChats = chats.filter((chat) => chat.isFavorite);

  return (
    <Drawer
      variant="permanent"
      anchor="left"
      slotProps={{
        paper: {
          sx: {
            width: NAV_WIDTH,
            overflow: 'hidden',
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            pt: 1,
            pb: 1,
            gap: 0.5,
            position: 'relative',
          },
        },
      }}
    >
      <Tooltip title="New Chat" placement="right">
        <IconButton onClick={onNewChat} size="small">
          <AddIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Divider flexItem sx={{ my: 0.5 }} />

      <Tooltip title="Search" placement="right">
        <IconButton onClick={onSearch} size="small">
          <SearchIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Tooltip title="Recent Chats" placement="right">
        <IconButton size="small" onClick={(event) => setRecentAnchor(event.currentTarget)}>
          <HistoryIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <ChatListPopover
        anchorEl={recentAnchor}
        title="Recent Chats"
        chats={recentChats}
        activeChatId={activeChatId}
        onSelect={onChatSelect}
        onClose={() => setRecentAnchor(null)}
      />

      <Tooltip title="Favorites" placement="right">
        <IconButton size="small" onClick={(event) => setFavoritesAnchor(event.currentTarget)}>
          <StarIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <ChatListPopover
        anchorEl={favoritesAnchor}
        title="Favorites"
        chats={favoriteChats}
        activeChatId={activeChatId}
        onSelect={onChatSelect}
        onClose={() => setFavoritesAnchor(null)}
        emptyText="No favorites yet"
      />
    </Drawer>
  );
}
