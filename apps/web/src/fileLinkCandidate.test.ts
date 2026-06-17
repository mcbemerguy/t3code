import { describe, expect, it } from "vite-plus/test";

import { isHighConfidenceAutolinkPath } from "./fileLinkCandidate";

describe("isHighConfidenceAutolinkPath", () => {
  it("accepts high-confidence absolute and workspace-relative file paths", () => {
    expect(isHighConfidenceAutolinkPath(String.raw`C:\Users\me\repo\src\main.py`)).toBe(true);
    expect(isHighConfidenceAutolinkPath(String.raw`C:\Users\Jane Doe\repo\src\main.py`)).toBe(true);
    expect(isHighConfidenceAutolinkPath("C:/Users/me/repo/src/main.py:10")).toBe(true);
    expect(isHighConfidenceAutolinkPath("C:/Program Files/repo/src/main.py:10")).toBe(true);
    expect(isHighConfidenceAutolinkPath("/Users/me/repo/src/main.ts")).toBe(true);
    expect(isHighConfidenceAutolinkPath("./src/main.ts")).toBe(true);
    expect(isHighConfidenceAutolinkPath("../lib/file.ts:12:3")).toBe(true);
    expect(isHighConfidenceAutolinkPath("src/components/Button.tsx")).toBe(true);
  });

  it("allows only well-known bare filenames", () => {
    expect(isHighConfidenceAutolinkPath("package.json", "/repo/project")).toBe(true);
    expect(isHighConfidenceAutolinkPath("README.md", "/repo/project")).toBe(true);
    expect(isHighConfidenceAutolinkPath("foo.py", "/repo/project")).toBe(false);
    expect(isHighConfidenceAutolinkPath("Button.tsx", "/repo/project")).toBe(false);
  });

  it("rejects common false positives", () => {
    expect(isHighConfidenceAutolinkPath("**/*.py", "/repo/project")).toBe(false);
    expect(isHighConfidenceAutolinkPath("src/**/*.ts", "/repo/project")).toBe(false);
    expect(isHighConfidenceAutolinkPath("foo?.ts", "/repo/project")).toBe(false);
    expect(isHighConfidenceAutolinkPath("$HOME/file.ts", "/repo/project")).toBe(false);
    expect(isHighConfidenceAutolinkPath("/chat/settings", "/repo/project")).toBe(false);
    expect(isHighConfidenceAutolinkPath("https://example.com/docs", "/repo/project")).toBe(false);
    expect(isHighConfidenceAutolinkPath("<file.ts>", "/repo/project")).toBe(false);
  });
});
