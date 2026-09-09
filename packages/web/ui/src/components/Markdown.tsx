import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { useT } from "@/lib/i18n";
import { resolveImage, resolveLink } from "@/lib/links";

const plugins = [remarkGfm];

/**
 * Renders a workspace document. Raw HTML is dropped by react-markdown; every
 * link and image is resolved against the document path so nothing outside
 * Work or Knowledge is fetched or navigated to.
 */
export function Markdown({ source, path }: { source: string; path: string }) {
  const { t } = useT();
  const components: ComponentProps<typeof ReactMarkdown>["components"] = {
    a: ({ href, children, node: _node, ...rest }) => {
      const link = resolveLink(path, href ?? "");
      if (link.kind === "external")
        return (
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            {...rest}
          >
            {children}
          </a>
        );
      if (link.kind === "anchor")
        return (
          <a href={link.href} {...rest}>
            {children}
          </a>
        );
      if (link.kind === "route")
        return (
          <Link to={link.to} {...rest}>
            {children}
          </Link>
        );
      return (
        <span className="unsupported" title={t("unsupportedLink")}>
          {children}
        </span>
      );
    },
    img: ({ src, alt, node: _node, ...rest }) => {
      const url = resolveImage(path, typeof src === "string" ? src : "");
      if (!url)
        return (
          <span className="text-muted-foreground" title={t("externalImage")}>
            [{alt || t("externalImage")}]
          </span>
        );
      return <img src={url} alt={alt ?? ""} loading="lazy" {...rest} />;
    },
    li: ({ children, className, node: _node, ...rest }) => (
      <li
        className={className?.includes("task-list-item") ? "task" : className}
        {...rest}
      >
        {children}
      </li>
    ),
    input: ({ node: _node, ...rest }) => (
      <input {...rest} disabled readOnly aria-readonly />
    ),
  };
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        skipHtml
        urlTransform={(url) => url}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
