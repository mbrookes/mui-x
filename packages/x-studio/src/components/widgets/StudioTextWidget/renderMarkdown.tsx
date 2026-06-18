'use client';
import * as React from 'react';
import Markdown from 'markdown-to-jsx';

function sanitizeUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? value : null;
  } catch {
    if (!value.includes(':') && !/^[/\\]{2}/.test(value)) {
      return value;
    }
    return null;
  }
}

const markdownOptions = {
  forceBlock: true,
  wrapper: React.Fragment,
  disableParsingRawHTML: true,
  sanitizer: sanitizeUrl,
};

export function renderMarkdown(text: string): React.ReactNode {
  return <Markdown options={markdownOptions}>{text}</Markdown>;
}
