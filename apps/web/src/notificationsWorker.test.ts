// @effect-diagnostics nodeBuiltinImport:off -- Executes the actual shipped worker in an isolated JavaScript context.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";

const source = NodeFS.readFileSync(
  new URL("../public/notifications-sw.js", import.meta.url),
  "utf8",
);
const origin = "https://t3.test";
type Client = {
  url: string;
  navigate: (url: string) => Promise<Client | null>;
  focus: () => Promise<Client>;
};
type Click = {
  notification: { data: { path: string }; close: () => void };
  waitUntil: (promise: Promise<unknown>) => void;
};

async function click(
  path: string,
  options: {
    legacy?: boolean;
    existing?: boolean;
    disappeared?: boolean;
    opensAtRoot?: boolean;
  } = {},
) {
  const calls: Array<[string, string?]> = [];
  const client: Client = {
    url: origin + "/",
    navigate: async (url) => {
      calls.push(["navigate", url]);
      client.url = url;
      return options.disappeared ? null : client;
    },
    focus: async () => {
      calls.push(["focus"]);
      return client;
    },
  };
  let handler: ((event: Click) => void) | undefined;
  let completion: Promise<unknown> | undefined;
  const self = {
    location: {
      origin,
      href: origin + "/notifications-sw.js" + (options.legacy ? "?nativeApp=maxi" : ""),
    },
    addEventListener: (type: string, callback: unknown) => {
      if (type === "notificationclick") handler = callback as (event: Click) => void;
    },
    clients: {
      matchAll: async () => (options.existing ? [client] : []),
      openWindow: async (url: string) => {
        calls.push(["open", url]);
        return options.opensAtRoot ? client : null;
      },
    },
  };
  NodeVM.runInNewContext(source, { self, URL, URLSearchParams });
  if (!handler) throw new Error("Missing notification click handler");
  handler({
    notification: { data: { path }, close: () => {} },
    waitUntil: (value) => {
      completion = value;
    },
  });
  await completion;
  return calls;
}

it.each([false, true])(
  "opens the chat inside the web app, including legacy native registrations (%s)",
  async (legacy) => {
    expect(await click("/env/mcp%3Alaunch%3Athread", { legacy })).toEqual([
      ["open", origin + "/env/mcp%3Alaunch%3Athread"],
    ]);
  },
);
it("navigates and focuses an existing app window", async () => {
  expect(await click("/env/thread", { existing: true })).toEqual([
    ["navigate", origin + "/env/thread"],
    ["focus"],
  ]);
});
it("corrects an operating-system launch at the home screen once", async () => {
  expect(await click("/env/thread", { opensAtRoot: true })).toEqual([
    ["open", origin + "/env/thread"],
    ["navigate", origin + "/env/thread"],
    ["focus"],
  ]);
});
it("opens a fresh window if the old one disappeared during navigation", async () => {
  expect(await click("/env/thread", { existing: true, disappeared: true })).toEqual([
    ["navigate", origin + "/env/thread"],
    ["open", origin + "/env/thread"],
  ]);
});
it.each([
  "https://elsewhere.test/chat",
  "//elsewhere.test/chat",
  "/env/thread?prompt=run",
  "/env/thread#command",
])("refuses a notification navigation outside the plain app path: %s", async (path) => {
  expect(await click(path)).toEqual([]);
});
