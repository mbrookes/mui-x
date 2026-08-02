import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './renderMarkdown';

const { render } = createRenderer();

// `renderMarkdown` is the text widget's ENTIRE sanitization boundary for markdown that is
// authored by an LLM (`useTextWidgetAI`'s output, driven by a `textBody` prompt that travels
// inside a shared dashboard doc) or by whoever authored a persisted doc loaded through
// `loadSerializedState(data: unknown)`. Both routes are attacker-influenced.
//
// It was previously executed by NO test in the repository: `renderMarkdown` is called only
// from `TextWidgetAIContent`, which renders only once `useTextWidgetAI` has produced
// `markdown`, and neither `StudioTextWidget.test.tsx` (plain `textBody` path only) nor
// `useTextWidgetAI.test.tsx` reaches that branch. A mutant replacing the whole render with
// `<Markdown>{''}</Markdown>` — i.e. the module emitting nothing at all — passed the full
// project. These tests call the exported function directly so the boundary is executed.
function renderMd(markdown: string) {
  return render(<div data-testid="md">{renderMarkdown(markdown)}</div>).container
    .firstElementChild as HTMLElement;
}

describe('renderMarkdown', () => {
  // ── The control ─────────────────────────────────────────────────────────────
  // This test is deliberately first and deliberately blunt: it fails if the module renders
  // NOTHING. Its absence is precisely why every sanitizer clause below sat unobserved — the
  // five sanitizer assertions are only meaningful if something is actually being rendered,
  // and without this test they would all pass against an empty render.
  it('renders the markdown as elements (fails if the module renders nothing at all)', () => {
    const host = renderMd('# Title\n\nSome **bold** copy.\n\n- one\n- two\n');

    expect(host.textContent).toContain('Title');
    expect(host.textContent).toContain('Some bold copy.');
    // Structure, not just text: markdown must be parsed into elements rather than dumped
    // as a single text node (or dropped entirely).
    expect(host.querySelector('h1')?.textContent).toBe('Title');
    expect(host.querySelector('strong')?.textContent).toBe('bold');
    expect(host.querySelectorAll('li')).toHaveLength(2);
  });

  // ── Remote images: blocked (W1) ─────────────────────────────────────────────
  describe('remote image blocking', () => {
    it('strips the src of a remote markdown image so no request is issued', () => {
      const host = renderMd('![x](https://attacker.example/pixel.png)');

      const img = host.querySelector('img');
      // The <img> element itself is still emitted (alt text survives) — what must not
      // survive is the attacker-chosen URL, which would otherwise be fetched with zero
      // interaction and leak the viewer's IP/timing.
      expect(img).not.toBe(null);
      expect(img!.getAttribute('src')).toBe(null);
      expect(host.innerHTML).not.toContain('attacker.example');
    });

    it('strips the src of an http image and of a same-looking relative image', () => {
      const remote = renderMd('![a](http://attacker.example/p.gif)');
      expect(remote.querySelector('img')!.getAttribute('src')).toBe(null);

      // Images are blocked unconditionally — the guard keys on tag/attribute before it ever
      // looks at the protocol, so even a relative image src is dropped.
      const relative = renderMd('![b](/local/pixel.png)');
      expect(relative.querySelector('img')!.getAttribute('src')).toBe(null);
    });
  });

  // ── Link protocol allowlist (W2) ────────────────────────────────────────────
  describe('link protocol allowlist', () => {
    it('strips a javascript: href', () => {
      const host = renderMd('[click](javascript:alert(1))');

      const anchor = host.querySelector('a');
      expect(anchor).not.toBe(null);
      expect(anchor!.textContent).toBe('click');
      expect(anchor!.getAttribute('href')).toBe(null);
      expect(host.innerHTML).not.toContain('javascript:');
    });

    it('strips a data: href', () => {
      const host = renderMd('[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)');

      const anchor = host.querySelector('a');
      expect(anchor).not.toBe(null);
      expect(anchor!.getAttribute('href')).toBe(null);
      expect(host.innerHTML).not.toContain('data:text/html');
    });

    it('keeps http, https and mailto hrefs — the allowlist is not a blanket rejection', () => {
      const https = renderMd('[ok](https://example.com/page)');
      expect(https.querySelector('a')!.getAttribute('href')).toBe('https://example.com/page');

      const http = renderMd('[ok](http://example.com/page)');
      expect(http.querySelector('a')!.getAttribute('href')).toBe('http://example.com/page');

      const mail = renderMd('[mail](mailto:someone@example.com)');
      expect(mail.querySelector('a')!.getAttribute('href')).toBe('mailto:someone@example.com');
    });
  });

  // ── Protocol-relative rejection in the relative-URL fallback (W3) ───────────
  describe('relative URL fallback', () => {
    it('rejects a protocol-relative //host href', () => {
      const host = renderMd('[click](//attacker.example/path)');

      const anchor = host.querySelector('a');
      expect(anchor).not.toBe(null);
      expect(anchor!.getAttribute('href')).toBe(null);
      expect(host.innerHTML).not.toContain('attacker.example');
    });

    it('rejects the mixed slash-backslash /\\host protocol-relative variant', () => {
      // Browsers treat `/\host` as protocol-relative just like `//host`, which is why the
      // guard is a `[/\\]{2}` character class rather than a literal `//` check.
      const host = renderMd('[click](/\\attacker.example/path)');

      expect(host.querySelector('a')!.getAttribute('href')).toBe(null);
      expect(host.innerHTML).not.toContain('attacker.example');
    });

    it('keeps an ordinary relative href', () => {
      const host = renderMd('[docs](/docs/getting-started)');
      expect(host.querySelector('a')!.getAttribute('href')).toBe('/docs/getting-started');
    });

    it('rejects an unparseable value that still carries a colon', () => {
      // Falls into the `catch` (not an absolute URL) but contains `:` — a scheme-ish value
      // that the allowlist above never got to see must not be let through by the fallback.
      const host = renderMd('[click](vbscript:msgbox(1))');
      expect(host.querySelector('a')!.getAttribute('href')).toBe(null);
    });
  });

  // ── Raw HTML parsing disabled (W4) ──────────────────────────────────────────
  describe('raw HTML', () => {
    it('escapes raw HTML instead of parsing it into elements', () => {
      const host = renderMd('<img src="x" onerror="alert(1)"><b>bold</b>');

      // No element is produced from the raw markup...
      expect(host.querySelector('img')).toBe(null);
      expect(host.querySelector('b')).toBe(null);
      // ...and no event-handler attribute lands on any element. (The word `onerror` DOES
      // still appear in `innerHTML` — as escaped text inside a text node, which is exactly
      // the point — so the assertion has to be about attributes, not about the string.)
      expect(host.querySelector('[onerror]')).toBe(null);
      // The markup survives as visible TEXT, which is the documented behaviour.
      expect(host.textContent).toContain('<b>bold</b>');
    });

    it('escapes a raw <script> block instead of parsing it', () => {
      const host = renderMd('<script>alert(1)</script>');

      expect(host.querySelector('script')).toBe(null);
      expect(host.textContent).toContain('<script>alert(1)</script>');
    });
  });
});
