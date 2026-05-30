import { MarkdownDocs } from '@mui/internal-core-docs/MarkdownDocs';
import * as pageProps from 'docs/data/studio/widgets/map/map.md?muiMarkdown';

export default function Page() {
  return <MarkdownDocs {...pageProps} disableAd />;
}
