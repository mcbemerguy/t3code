import { memo, useMemo, type ReactNode } from "react";

import { isHighConfidenceAutolinkPath } from "../../fileLinkCandidate";
import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "../../markdown-links";
import { extractTerminalLinks } from "../../terminal-links";
import { cn } from "../../lib/utils";
import { MarkdownFileLink } from "./MarkdownFileLink";

export interface InlineFilePathTextProps {
  text: string;
  cwd: string | undefined;
  theme: "light" | "dark";
  className?: string | undefined;
  linkClassName?: string | undefined;
  enabled?: boolean | undefined;
}

export const INLINE_FILE_LINK_CLASS_NAME =
  "top-0 !border-0 !bg-transparent !p-0 !text-[inherit] !leading-[inherit] hover:!bg-transparent";

export const InlineFilePathText = memo(function InlineFilePathText({
  text,
  cwd,
  theme,
  className,
  linkClassName,
  enabled = true,
}: InlineFilePathTextProps) {
  const parts = useMemo(
    () => (enabled ? renderInlineFilePathParts(text, cwd, theme, linkClassName) : text),
    [cwd, enabled, linkClassName, text, theme],
  );
  return <>{className ? <span className={className}>{parts}</span> : parts}</>;
});

export function mayContainFilePath(text: string, cwd?: string): boolean {
  if (text.length === 0) return false;
  if (/[\\/]/.test(text)) return true;
  if (/[A-Za-z]:[\\/]/.test(text)) return true;
  if (cwd && /(?:^|\s)[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}(?=$|\s|[),.;!?])/.test(text)) {
    return true;
  }
  return false;
}

export function renderInlineFilePathParts(
  text: string,
  cwd: string | undefined,
  theme: "light" | "dark",
  linkClassName?: string | undefined,
): ReactNode {
  if (!mayContainFilePath(text, cwd)) return text;

  const matches = extractTerminalLinks(text).filter((match) => match.kind === "path");
  if (matches.length === 0) return text;

  const children: ReactNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start < cursor) continue;

    const before = text.slice(cursor, match.start);
    if (before) children.push(before);

    const meta = isHighConfidenceAutolinkPath(match.text, cwd)
      ? resolveMarkdownFileLinkMeta(match.text, cwd)
      : null;
    children.push(
      meta
        ? renderFileLink(match.text, meta, theme, linkClassName, `${match.start}:${match.end}`)
        : match.text,
    );
    cursor = match.end;
  }

  const after = text.slice(cursor);
  if (after) children.push(after);

  return children.length > 0 ? children : text;
}

export function InlineFilePathLink({
  text,
  cwd,
  theme,
  className,
  showIcon = false,
}: {
  text: string;
  cwd: string | undefined;
  theme: "light" | "dark";
  className?: string | undefined;
  showIcon?: boolean | undefined;
}) {
  const meta = isHighConfidenceAutolinkPath(text, cwd)
    ? resolveMarkdownFileLinkMeta(text, cwd)
    : null;
  if (!meta) return <>{text}</>;
  return renderFileLink(text, meta, theme, className, text, showIcon);
}

function renderFileLink(
  text: string,
  meta: MarkdownFileLinkMeta,
  theme: "light" | "dark",
  className: string | undefined,
  key: string,
  showIcon = false,
): ReactNode {
  return (
    <MarkdownFileLink
      key={key}
      href={meta.targetPath}
      targetPath={meta.targetPath}
      displayPath={meta.displayPath}
      filePath={meta.filePath}
      label={text}
      theme={theme}
      className={cn(INLINE_FILE_LINK_CLASS_NAME, className)}
      showIcon={showIcon}
    />
  );
}
