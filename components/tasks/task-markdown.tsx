import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children, node: _node, ...props }) =>
    href?.startsWith("/") && !href.startsWith("//") ? (
      <Link href={href} {...props}>
        {children}
      </Link>
    ) : (
      <a href={href} rel="noopener noreferrer nofollow" {...props}>
        {children}
      </a>
    ),
};

/**
 * Task text may come from agents: Markdown only, never raw HTML, and no
 * images (a remote image would report when the owner opens the task).
 */
export function TaskMarkdown({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      skipHtml
      disallowedElements={["img"]}
      unwrapDisallowed
    >
      {markdown}
    </ReactMarkdown>
  );
}
