import { expect, it } from "vite-plus/test";
import { cacheKindForQuery } from "./pull-request-cache-store";

it("keeps hook and pull request caches separate", () => {
  expect(
    cacheKindForQuery(JSON.stringify(["environment-data:hooks:list", { projectId: "p" }])),
  ).toBe("hooks");
  expect(cacheKindForQuery(JSON.stringify(["environment-data:pull-request:list", {}]))).toBe(
    "pull-request",
  );
});
