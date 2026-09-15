import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { resolveImage, resolveLink } from "@/lib/links";

const plugins = [remarkGfm];

/** Adds a copy action without changing the Markdown source or loading a highlighter. */
function CodeBlock({ children, ...rest }: ComponentProps<"pre">) {
  const { t } = useT();
  const blockRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const text = blockRef.current?.querySelector("code")?.textContent;
    if (text === undefined) return;
    void copyText(text).then((ok) => setCopied(ok));
  };

  return (
    <div className="code-block">
      <pre ref={blockRef} {...rest}>
        {children}
      </pre>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className="code-copy-button"
            variant="muted"
            size="icon-sm"
            aria-label={copied ? t("copiedCode") : t("copyCode")}
            data-testid="copy-code"
            onClick={copy}
          >
            {copied ? (
              <CheckIcon className="size-3.5 text-primary" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {copied ? t("copiedCode") : t("copyCode")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

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
    pre: ({ children, node: _node, ...rest }) => (
      <CodeBlock {...rest}>{children}</CodeBlock>
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
