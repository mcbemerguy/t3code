import type { ExpectPollOptions } from "vite-plus/test";
import type { Locator } from "vite-plus/test/browser";

type BrowserElementTarget = HTMLElement | SVGElement | null | Locator;
type ExpectElement = (element: BrowserElementTarget, options?: ExpectPollOptions) => any;

declare module "vitest" {
  interface ExpectStatic {
    element: ExpectElement;
  }
}

declare module "vite-plus/test" {
  interface ExpectStatic {
    element: ExpectElement;
  }
}
