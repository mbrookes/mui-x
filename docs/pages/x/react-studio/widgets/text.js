import { MarkdownDocs } from '@mui/internal-core-docs/MarkdownDocs';
import * as pageProps from 'docs/data/studio/widgets/text/text.md?muiMarkdown';

export default function Page() {
  return <MarkdownDocs {...pageProps} />;
}
