import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import { ensureLocalApi } from "../../localApi";
import { resolveHelpLink } from "./helpLinks";

// An answer sits below the page's h1, the conversation's h2, and its message's h3. As in
// ChatMarkdown, override only the exposed level; the tag keeps the shared prose sizes.
function answerHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function AnswerHeading({
    node: _node,
    ...props
  }: ComponentProps<typeof Tag> & ExtraProps) {
    return <Tag {...props} aria-level={Math.min(level + 3, 6)} />;
  };
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const link = resolveHelpLink(href);
    if (!link) return <span>{children}</span>;
    if (link.kind === "internal") {
      return (
        <Link to={link.to} hash={link.hash}>
          {children}
        </Link>
      );
    }
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        onClick={(event) => {
          event.preventDefault();
          void ensureLocalApi()
            .shell.openExternal(link.href)
            .catch(() => undefined);
        }}
      >
        {children}
      </a>
    );
  },
  h1: answerHeading(1),
  h2: answerHeading(2),
  h3: answerHeading(3),
  h4: answerHeading(4),
  h5: answerHeading(5),
  h6: answerHeading(6),
};

/** Renders a Help answer with the same prose styles as answers in a thread. */
export function HelpMarkdown({ content }: { readonly content: string }) {
  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)] wrap-anywhere [&_p]:whitespace-pre-wrap">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(url) => (resolveHelpLink(url) ? url : "")}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </Markdown>
    </div>
  );
}
