import { describe, expect, it } from "vitest";

import { resolveMarkdownCodeSpanPathLinkMeta } from "./markdown-code-path-links";

describe("resolveMarkdownCodeSpanPathLinkMeta", () => {
  it("resolves relative path-like code spans against cwd", () => {
    expect(
      resolveMarkdownCodeSpanPathLinkMeta("src/components/ChatMarkdown.tsx:42", "/repo/project"),
    ).toMatchObject({
      filePath: "/repo/project/src/components/ChatMarkdown.tsx",
      targetPath: "/repo/project/src/components/ChatMarkdown.tsx:42",
      displayPath: "project/src/components/ChatMarkdown.tsx:42",
      basename: "ChatMarkdown.tsx",
      line: 42,
    });
  });

  it("accepts workspace file names with text extensions", () => {
    expect(resolveMarkdownCodeSpanPathLinkMeta("package.json", "/repo/project")).toMatchObject({
      filePath: "/repo/project/package.json",
      targetPath: "/repo/project/package.json",
      displayPath: "project/package.json",
      basename: "package.json",
    });
  });

  it("rejects URL-like, version-like, and generic angle-bracket code spans", () => {
    expect(
      resolveMarkdownCodeSpanPathLinkMeta("https://example.com/docs", "/repo/project"),
    ).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("1.2.3", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("<foo.ts>", "/repo/project")).toBeNull();
  });
});
