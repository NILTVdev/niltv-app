/**
 * GitHub-style Markdown for text staff write. Raw HTML is never rendered and
 * link targets go through the library's safe-protocol check, so nothing in
 * the text can run in a reader's browser. `portal-image:{id}` points at an
 * image staff uploaded; `images` maps those ids to short-lived links.
 */
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const PLUGINS = [remarkGfm, remarkBreaks];
const PORTAL_IMAGE = "portal-image:";

export function Markdown({ text, images = {} }: { text: string; images?: Record<string, string> }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={PLUGINS}
        urlTransform={(url) =>
          url.startsWith(PORTAL_IMAGE) ? (images[url.slice(PORTAL_IMAGE.length)] ?? "") : defaultUrlTransform(url)
        }
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          img: ({ node: _node, src, alt }) => (src ? <img src={String(src)} alt={alt ?? ""} loading="lazy" /> : null),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
