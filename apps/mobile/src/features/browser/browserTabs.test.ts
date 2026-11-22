import { expect, it } from "vite-plus/test";

import { browserOpenErrorMessage, normalizeBrowserAddressDraft } from "./browserTabs";

it("normalizes a usable empty-browser address and rejects unsupported schemes", () => {
  expect(normalizeBrowserAddressDraft("https://example.com/path")).toBe("https://example.com/path");
  expect(normalizeBrowserAddressDraft("ftp://example.com")).toBeNull();
  expect(normalizeBrowserAddressDraft(" ")).toBeNull();
});

it("keeps a useful fallback when browser open fails without an Error", () => {
  expect(browserOpenErrorMessage(new Error("server refused the request"))).toBe(
    "server refused the request",
  );
  expect(browserOpenErrorMessage("unknown failure")).toBe(
    "Check the server connection and try again.",
  );
});
