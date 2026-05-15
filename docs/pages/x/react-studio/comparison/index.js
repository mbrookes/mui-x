import * as React from 'react';
import { MarkdownDocs } from '@mui/internal-core-docs/MarkdownDocs';
import * as pageProps from 'docs/data/studio/comparison/comparison.md?muiMarkdown';

export default function Page() {
  return <MarkdownDocs {...pageProps} />;
}
