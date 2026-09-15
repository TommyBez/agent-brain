import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children, node: _node, ...props }) => {
    const navigable =
      href &&
      !href.startsWith("#") &&
      (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) ||
        /^https?:\/\//i.test(href));
    // Next also routes absolute same-origin URLs. External HTTP links keep the
    // browser's normal navigation, without duplicating origin checks here.
    return navigable ? (
      <Link href={href} {...props}>
        {children}
      </Link>
    ) : (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
};

// Shared by server-rendered pages/revisions and the lazy client editor preview.
export function Markdown({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {markdown}
    </ReactMarkdown>
  );
}
