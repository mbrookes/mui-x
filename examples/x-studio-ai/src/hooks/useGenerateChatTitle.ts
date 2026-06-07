import * as React from 'react';
import type { StudioAIConfig } from '@mui/x-studio';

export function useGenerateChatTitle(aiConfig: StudioAIConfig | undefined) {
  const generateTitle = React.useCallback(
    async (firstMessage: string): Promise<{ title: string; description: string }> => {
      if (!aiConfig) {
        return { title: firstMessage.slice(0, 40), description: '' };
      }

      try {
        const url = `${aiConfig.endpoint.replace(/\/?$/, '')}/title`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(aiConfig.headers ?? {}),
          },
          body: JSON.stringify({ message: firstMessage }),
        });

        const data = await response.json();
        return data as { title: string; description: string };
      } catch {
        return { title: firstMessage.slice(0, 40), description: '' };
      }
    },
    [aiConfig],
  );

  return { generateTitle };
}
