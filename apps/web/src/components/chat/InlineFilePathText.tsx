import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

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
  deferred?: boolean | undefined;
}

export const INLINE_FILE_LINK_CLASS_NAME =
  "top-0 !border-0 !bg-transparent !p-0 !text-[inherit] !leading-[inherit] hover:!bg-transparent";

export const InlineFilePathText = memo(function InlineFilePathText({
  text,
  cwd,
  theme,
  className,
  linkClassName,
  deferred = false,
}: InlineFilePathTextProps) {
  const shouldResolve = useDeferredInlineResolution(text, cwd, deferred);
  const parts = useMemo(
    () => (shouldResolve ? renderInlineFilePathParts(text, cwd, theme, linkClassName) : text),
    [cwd, linkClassName, shouldResolve, text, theme],
  );
  return <>{className ? <span className={className}>{parts}</span> : parts}</>;
});

function useDeferredInlineResolution(
  text: string,
  cwd: string | undefined,
  deferred: boolean,
): boolean {
  const canLink = mayContainFilePath(text, cwd);
  const resolutionKey = `${cwd ?? ""}\n${text}`;
  const [readyKey, setReadyKey] = useState<string | null>(
    !deferred || !canLink ? resolutionKey : null,
  );

  useEffect(() => {
    if (!deferred || !canLink) {
      setReadyKey(resolutionKey);
      return;
    }

    setReadyKey(null);
    const windowWithIdle = window as Window & {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const handle = windowWithIdle.requestIdleCallback
      ? windowWithIdle.requestIdleCallback(() => setReadyKey(resolutionKey))
      : window.setTimeout(() => setReadyKey(resolutionKey), 0);
    return () => {
      if (windowWithIdle.cancelIdleCallback) {
        windowWithIdle.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, [canLink, deferred, resolutionKey]);

  return readyKey === resolutionKey;
}

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

    const meta = resolveMarkdownFileLinkMeta(match.text, cwd);
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
  const meta = resolveMarkdownFileLinkMeta(text, cwd);
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
