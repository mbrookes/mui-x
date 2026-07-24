'use client';
import * as React from 'react';
import Markdown from 'markdown-to-jsx';

function sanitizeUrl(value: string, tag: string, attribute: string): string | null {
  // Block markdown image loads to a remote origin. Even with raw HTML disabled and
  // javascript:/protocol-relative URLs rejected below, `![x](https://attacker/pixel)`
  // still emits an <img> that fetches an attacker-chosen URL with zero interaction,
  // leaking the viewer's IP/timing from a shared or AI-authored doc. Images are only
  // blocked here (not links) — an <a href> still allows http/https since navigation is
  // an explicit user action.
  if (tag === 'img' && attribute === 'src') {
    return null;
  }
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
