import * as React from 'react';
import MarkdownDocs from 'docs/src/modules/components/MarkdownDocs';
import * as pageProps from '../../../data/studio/features/global-filters/global-filters.md?muiMarkdown';

export default function Page() {
  return <MarkdownDocs {...pageProps} />;
}
