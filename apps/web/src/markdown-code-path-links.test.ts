import { describe, expect, it } from "vite-plus/test";

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

  it("accepts allowlisted bare workspace file names", () => {
    expect(resolveMarkdownCodeSpanPathLinkMeta("package.json", "/repo/project")).toMatchObject({
      filePath: "/repo/project/package.json",
      targetPath: "/repo/project/package.json",
      displayPath: "project/package.json",
      basename: "package.json",
    });
  });

  it("resolves Windows code-span paths with spaces", () => {
    expect(
      resolveMarkdownCodeSpanPathLinkMeta(
        "C:/Program Files/t3 code/src/main.ts:12",
        "C:/Program Files/t3 code",
      ),
    ).toMatchObject({
      filePath: "C:/Program Files/t3 code/src/main.ts",
      targetPath: "C:/Program Files/t3 code/src/main.ts:12",
      displayPath: "t3 code/src/main.ts:12",
      basename: "main.ts",
      line: 12,
    });
  });

  it("requires a directory signal for ordinary source file names", () => {
    expect(resolveMarkdownCodeSpanPathLinkMeta("ChatMarkdown.tsx", "/repo/project")).toBeNull();
    expect(
      resolveMarkdownCodeSpanPathLinkMeta("./src/components/index.ts", "/repo/project"),
    ).toMatchObject({
      filePath: "/repo/project/./src/components/index.ts",
      targetPath: "/repo/project/./src/components/index.ts",
      displayPath: "project/./src/components/index.ts",
      basename: "index.ts",
    });
  });

  it("rejects URL-like, version-like, and generic angle-bracket code spans", () => {
    expect(
      resolveMarkdownCodeSpanPathLinkMeta("https://example.com/docs", "/repo/project"),
    ).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("1.2.3", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("<foo.ts>", "/repo/project")).toBeNull();
  });

  it("rejects glob patterns, shell-like snippets, common code identifiers, and slash-separated prose", () => {
    expect(resolveMarkdownCodeSpanPathLinkMeta("**/*.py", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("src/**/*.ts", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("$HOME/src/main.ts", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("props.children", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("error.message", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("process.env", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("React.memo", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("Ctrl/Cmd", "/repo/project")).toBeNull();
    expect(resolveMarkdownCodeSpanPathLinkMeta("input/output", "/repo/project")).toBeNull();
  });
});
