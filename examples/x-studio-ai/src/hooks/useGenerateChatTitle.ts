import * as React from 'react';
import type { StudioAIConfig } from '@mui/x-studio';

export function useGenerateChatTitle(aiConfig: StudioAIConfig | undefined) {
  const generateTitle = React.useCallback(
    async (firstMessage: string): Promise<{ title: string; description: string }> => {
      if (!aiConfig) {
        return { title: firstMessage.slice(0, 40), description: '' };
      }

      try {
        const response = await fetch(aiConfig.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(aiConfig.apiKey ? { Authorization: `Bearer ${aiConfig.apiKey}` } : {}),
            ...(aiConfig.headers ?? {}),
          },
          body: JSON.stringify({
            model: aiConfig.model ?? 'gpt-4o',
            messages: [
              {
                role: 'system',
                content:
                  'Generate a short title (max 6 words) and a one-sentence description for a ' +
                  "dashboard analytics chat session based on the user's first message. " +
                  'Respond ONLY with valid JSON: {"title": "...", "description": "..."}',
              },
              { role: 'user', content: firstMessage },
            ],
            max_tokens: 100,
            temperature: 0.3,
          }),
        });

        const data = await response.json();
        return JSON.parse(data.choices[0].message.content) as {
          title: string;
          description: string;
        };
      } catch {
        return { title: firstMessage.slice(0, 40), description: '' };
      }
    },
    [aiConfig],
  );

  return { generateTitle };
}
