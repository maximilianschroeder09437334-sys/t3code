import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement } from "react";
import type { PreviewStreamEvents } from "@t3tools/client-runtime/preview/server-browser-stream";
import type { EnvironmentId } from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  cells: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void | (() => void))[],
  paints: [] as {
    painted: () => void;
    error: (error: Error) => void;
    stop: ReturnType<typeof vi.fn>;
  }[],
  clients: [] as PreviewStreamEvents[],
  access: {
    httpBase: "http://preview.test",
    wsBase: "ws://preview.test",
    query: {},
    credentials: true,
  },
}));

// Run the real component's effects in Node; no DOM, browser, transport or decoder is started.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.cells)) harness.cells[index] = initial;
    return [
      harness.cells[index],
      (value: unknown) => {
        harness.cells[index] = typeof value === "function" ? value(harness.cells[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.cells)) harness.cells[index] = { current: initial };
    return harness.cells[index];
  },
  useEffect: (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  },
  useEffectEvent: (callback: unknown) => callback,
  useImperativeHandle: () => undefined,
}));
vi.mock("@t3tools/client-runtime/preview/server-browser-stream", () => ({
  createPreviewFramePainter: (
    _canvas: unknown,
    painted: () => void,
    error: (error: Error) => void,
  ) => {
    const painter = { painted, error, stop: vi.fn(), paint: vi.fn() };
    harness.paints.push(painter);
    return painter;
  },
  createPreviewStreamClient: (_target: unknown, events: PreviewStreamEvents) => {
    harness.clients.push(events);
    return { send: vi.fn(), stop: vi.fn() };
  },
  previewStreamControlLabel: () => "",
}));
vi.mock("~/state/previewStream", () => ({ usePreviewStreamAccess: () => harness.access }));
vi.mock("~/lib/observeResize", () => ({
  observeResize: (_element: unknown, callback: () => void) => {
    callback();
    return () => undefined;
  },
}));
vi.mock("~/components/preview/AgentBrowserCursor", () => ({ AgentCursorMark: () => null }));
vi.mock("~/components/CommandBlock", () => ({ CommandBlock: () => null }));
vi.mock("~/components/ui/button", () => ({ Button: () => null }));
vi.mock("~/components/ui/input", () => ({ Input: () => null }));
vi.mock("~/components/ui/toast", () => ({ toastManager: {} }));
vi.mock("~/lib/utils", () => ({ cn: () => "" }));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children)];
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ServerBrowserSurface stream attempt diagnostics", () => {
  it("resets each attempt's errors and paint state while preserving the component's first-frame callback", async () => {
    harness.cells = [];
    harness.paints = [];
    harness.clients = [];
    vi.useFakeTimers();
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    const firstFrame = vi.fn();
    const canvas = {
      parentElement: { getBoundingClientRect: () => ({ width: 400, height: 300 }) },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    let visible = true;
    const render = () => {
      harness.cursor = 0;
      harness.effects = [];
      const tree = ServerBrowserSurface({
        environmentId: "env" as EnvironmentId,
        threadId: "thread",
        tabId: "tab",
        visible,
        onFirstFrame: firstFrame,
      });
      const ref = elements(tree).find((element) => element.type === "canvas")!.props.ref as {
        current: unknown;
      };
      ref.current = canvas;
      return tree;
    };
    let cleanups: (() => void)[] = [];
    const restart = () => {
      cleanups.forEach((cleanup) => cleanup());
      render();
      cleanups = harness.effects
        .map((effect) => effect())
        .filter((cleanup): cleanup is () => void => typeof cleanup === "function");
    };
    const alerts = () =>
      elements(render())
        .filter((element) => element.props.role === "alert")
        .flatMap((element) => element.props.children)
        .join("");
    restart();
    await vi.runAllTimersAsync();
    restart();
    expect(harness.paints).toHaveLength(1);
    harness.paints[0]!.painted();
    expect(firstFrame).toHaveBeenCalledOnce();
    expect(alerts()).toBe("");

    restart();
    expect(harness.paints[0]!.stop).toHaveBeenCalledOnce();
    harness.paints[1]!.error(new Error("attempt B failed"));
    expect(alerts()).toContain("attempt B failed");
    restart();
    expect(alerts()).toBe("");
    harness.paints[2]!.error(new Error("attempt C failed"));
    expect(alerts()).toContain("attempt C failed");
    harness.paints[2]!.painted();
    expect(alerts()).toBe("");
    expect(firstFrame).toHaveBeenCalledOnce();
    harness.paints[2]!.error(new Error("later frame failed"));
    expect(alerts()).toBe("");

    visible = false;
    restart();
    expect(harness.paints).toHaveLength(3);
    visible = true;
    restart();
    harness.paints[3]!.error(new Error("visible again failed"));
    expect(alerts()).toContain("visible again failed");
    cleanups.forEach((cleanup) => cleanup());
  });
});
