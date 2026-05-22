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

  it("accepts workspace file names with known source or config extensions", () => {
    expect(resolveMarkdownCodeSpanPathLinkMeta("package.json", "/repo/project")).toMatchObject({
      filePath: "/repo/project/package.json",
      targetPath: "/repo/project/package.json",
      displayPath: "project/package.json",
      basename: "package.json",
    });
    expect(resolveMarkdownCodeSpanPathLinkMeta("ChatMarkdown.tsx", "/repo/project")).toMatchObject({
      filePath: "/repo/project/ChatMarkdown.tsx",
      targetPath: "/repo/project/ChatMarkdown.tsx",
      displayPath: "project/ChatMarkdown.tsx",
      basename: "ChatMarkdown.tsx",
    });
  });

  it("accepts explicitly prefixed paths even without an extension", () => {
    expect(resolveMarkdownCodeSpanPathLinkMeta("./src/components", "/repo/project")).toMatchObject({
      filePath: "/repo/project/./src/components",
      targetPath: "/repo/project/./src/components",
      displayPath: "project/./src/components",
      basename: "components",
    });
  });

  it("rejects URL-like, version-like, and generic angle-bracket code spans", () => {
    expect(
      resolveMarkdownCodeSpanPathLinkMeta("https://example.com/docs", "/repo/project"),
    ).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("1.2.3", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("<foo.ts>", "/repo/project")).toBeNull();
  });

  it("rejects common code identifiers and slash-separated prose", () => {
    expect(resolveMarkdownCodeSpanPathLinkMeta("props.children", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("error.message", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("process.env", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("React.memo", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("Ctrl/Cmd", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("input/output", "/repo/project")).toBeNull();
  });
});
