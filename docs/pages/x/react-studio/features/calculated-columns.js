import * as React from 'react';
import MarkdownDocs from 'docs/src/modules/components/MarkdownDocs';
import * as pageProps from '../../../data/studio/features/calculated-columns/calculated-columns.md?muiMarkdown';

export default function Page() {
  return <MarkdownDocs {...pageProps} />;
}
