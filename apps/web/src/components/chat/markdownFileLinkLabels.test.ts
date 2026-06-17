import { describe, expect, it } from "vite-plus/test";

import { extractMarkdownLinkHrefs } from "./markdownFileLinkLabels";

describe("extractMarkdownLinkHrefs", () => {
  it("extracts angle-bracketed Windows link destinations with spaces", () => {
    expect(extractMarkdownLinkHrefs("[file](<C:/Program Files/t3 code/src/main.ts>)")).toEqual([
      "<C:/Program Files/t3 code/src/main.ts>",
    ]);
  });
});
