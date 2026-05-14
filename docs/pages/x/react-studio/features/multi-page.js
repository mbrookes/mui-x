import * as React from 'react';
import MarkdownDocs from 'docs/src/modules/components/MarkdownDocs';
import * as pageProps from '../../../data/studio/features/multi-page/multi-page.md?muiMarkdown';

export default function Page() {
  return <MarkdownDocs {...pageProps} />;
}
