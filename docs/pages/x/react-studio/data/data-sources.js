import { MarkdownDocs } from '@mui/internal-core-docs/MarkdownDocs';
import * as pageProps from 'docs/data/studio/data/data-sources/data-sources.md?muiMarkdown';

export default function Page() {
  return <MarkdownDocs {...pageProps} />;
}
