import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  InputBase,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import type { ChatSession } from '../hooks/useChatStore';

interface ChatSearchDialogProps {
  open: boolean;
  onClose: () => void;
  chats: ChatSession[];
  onSelect: (id: string) => void;
}

export function ChatSearchDialog({ open, onClose, chats, onSelect }: ChatSearchDialogProps) {
  const [query, setQuery] = React.useState('');

  const filtered = query.trim()
    ? chats.filter(
        (chat) =>
          chat.title.toLowerCase().includes(query.toLowerCase()) ||
          (chat.description ?? '').toLowerCase().includes(query.toLowerCase()),
      )
    : chats;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <SearchIcon color="action" />
        <InputBase
          autoFocus
          fullWidth
          placeholder="Search chats…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          sx={{ fontSize: '1rem' }}
        />
        <IconButton size="small" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 0, px: 1, pb: 1 }}>
        {filtered.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1 }}>
            {query ? 'No chats match your search.' : 'No chats yet.'}
          </Typography>
        ) : (
          <List dense disablePadding>
            {filtered.map((chat) => (
              <ListItemButton
                key={chat.id}
                onClick={() => {
                  onSelect(chat.id);
                  onClose();
                }}
                sx={{ borderRadius: 1 }}
              >
                <ListItemText
                  primary={chat.title}
                  secondary={chat.description ?? null}
                  slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
    </Dialog>
  );
}
