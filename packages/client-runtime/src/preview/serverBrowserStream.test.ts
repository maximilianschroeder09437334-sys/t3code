import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamControl,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("marks phone viewers for mobile viewport emulation", () => {
    const client = createPreviewStreamClient(
      { ...target, mobile: true },
      {
        onFrame: vi.fn(),
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    expect(FakeSocket.current.url).toContain("mobile=true");
    client.stop();
  });

  it("marks the desktop panel for native viewport restoration", () => {
    const client = createPreviewStreamClient(
      { ...target, localDesktop: true, deviceScaleFactor: 2 },
      {
        onFrame: vi.fn(),
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    expect(FakeSocket.current.url).toContain("localDesktop=true");
    expect(FakeSocket.current.url).toContain("deviceScaleFactor=2");
    client.stop();
  });

  it("reports whether the viewer owns the current viewport", () => {
    const onViewport = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onViewport,
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "viewport", width: 1024, height: 768, isActiveSizer: true }),
    );
    expect(onViewport).toHaveBeenCalledExactlyOnceWith({
      width: 1024,
      height: 768,
      isActiveSizer: true,
    });
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });

  it("withdraws an offered file picker when the stream drops or stops", () => {
    const onFileChooser = vi.fn();
    const events = {
      onFrame: vi.fn(),
      onFileChooser,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    };
    const client = createPreviewStreamClient(target, events);
    const socket = FakeSocket.current;
    socket.dispatchEvent(new Event("open"));
    socket.message(JSON.stringify({ type: "fileChooser", id: "c1", multiple: false, accept: "" }));
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1012 }));
    expect(onFileChooser).toHaveBeenLastCalledWith(null);
    client.stop();

    const restarted = createPreviewStreamClient(target, events);
    FakeSocket.current.message(
      JSON.stringify({ type: "fileChooser", id: "c2", multiple: false, accept: "" }),
    );
    restarted.stop();
    expect(onFileChooser).toHaveBeenLastCalledWith(null);
  });
});

describe("preview frame painter", () => {
  afterEach(() => vi.unstubAllGlobals());
  const flush = async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  };

  it("falls back to Image when bitmap decoding rejects and reports the fallback error", async () => {
    const context = { drawImage: vi.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const bitmapError = new Error("bitmap decode failed");
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(bitmapError));
    class FailedImage {
      naturalWidth = 2;
      naturalHeight = 3;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", FailedImage);
    const onError = vi.fn();
    const painter = createPreviewFramePainter(canvas, undefined, onError);
    painter.paint(new ArrayBuffer(1));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message:
          "The browser could not decode the preview JPEG. Bitmap decoder: bitmap decode failed",
      }),
    );
    painter.stop();
    vi.unstubAllGlobals();
  });

  it("closes a late bitmap after stop without painting or reporting errors", async () => {
    const context = { drawImage: vi.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    let resolve: ((bitmap: ImageBitmap) => void) | undefined;
    const bitmap = { width: 2, height: 3, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(
        () =>
          new Promise<ImageBitmap>((done) => {
            resolve = done;
          }),
      ),
    );
    const onPainted = vi.fn();
    const onError = vi.fn();
    const painter = createPreviewFramePainter(canvas, onPainted, onError);
    painter.paint(new ArrayBuffer(1));
    await flush();
    painter.stop();
    resolve?.(bitmap);
    await flush();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(onPainted).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports a successful first bitmap paint", async () => {
    const context = { drawImage: vi.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const bitmap = { width: 2, height: 3, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const onPainted = vi.fn();
    const painter = createPreviewFramePainter(canvas, onPainted);
    painter.paint(new ArrayBuffer(1));
    await flush();
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0);
    expect(onPainted).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
    painter.stop();
    vi.unstubAllGlobals();
  });

  const setup = (
    context: { drawImage: ReturnType<typeof vi.fn> } | null = { drawImage: vi.fn() },
  ) => {
    const images: FakeImage[] = [];
    class FakeImage {
      naturalWidth = 2;
      naturalHeight = 3;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        images.push(this);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    const createURL = vi.fn((_blob: Blob) => "blob:frame");
    const revokeURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: createURL, revokeObjectURL: revokeURL });
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const onPainted = vi.fn();
    const onError = vi.fn();
    return { images, createURL, revokeURL, context, canvas, onPainted, onError };
  };

  it("allocates no fallback resources when a pending bitmap rejects after stop", async () => {
    const s = setup();
    let reject!: (error: Error) => void;
    vi.stubGlobal(
      "createImageBitmap",
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const painter = createPreviewFramePainter(s.canvas, s.onPainted, s.onError);
    painter.paint(new ArrayBuffer(1));
    await flush();
    painter.stop();
    reject(new Error("late decode"));
    await flush();
    expect(s.images).toHaveLength(0);
    expect(s.createURL).not.toHaveBeenCalled();
    expect(s.onPainted).not.toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled();
  });

  it.each(["bitmap", "image"])(
    "reports missing 2D context exactly once with %s decoding",
    async (decoder) => {
      const s = setup(null);
      const close = vi.fn();
      vi.stubGlobal(
        "createImageBitmap",
        decoder === "bitmap"
          ? vi.fn().mockResolvedValue({ width: 2, height: 3, close })
          : undefined,
      );
      const painter = createPreviewFramePainter(s.canvas, s.onPainted, s.onError);
      painter.paint(new ArrayBuffer(1));
      if (decoder === "image") s.images[0]!.onload!();
      await flush();
      expect(s.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "The preview canvas has no 2D drawing context." }),
      );
      expect(s.onPainted).not.toHaveBeenCalled();
      if (decoder === "bitmap") {
        expect(close).toHaveBeenCalledOnce();
        expect(s.images).toHaveLength(0);
      } else expect(s.revokeURL).toHaveBeenCalledOnce();
      painter.stop();
    },
  );

  it.each(["absent", "rejected"])(
    "paints and releases a successful Image fallback when bitmap decoding is %s",
    async (decoder) => {
      const s = setup();
      vi.stubGlobal(
        "createImageBitmap",
        decoder === "absent" ? undefined : vi.fn().mockRejectedValue(new Error("unsupported")),
      );
      const painter = createPreviewFramePainter(s.canvas, s.onPainted, s.onError);
      painter.paint(new ArrayBuffer(1));
      await flush();
      const image = s.images[0]!;
      image.onload!();
      await flush();
      expect(s.context!.drawImage).toHaveBeenCalledExactlyOnceWith(image, 0, 0);
      expect(s.onPainted).toHaveBeenCalledOnce();
      expect(s.onError).not.toHaveBeenCalled();
      expect(s.revokeURL).toHaveBeenCalledExactlyOnceWith("blob:frame");
      expect(image.src).toBe("");
      expect(image.onload).toBeNull();
      expect(image.onerror).toBeNull();
      painter.stop();
      expect(s.revokeURL).toHaveBeenCalledOnce();
    },
  );

  it("keeps only the latest waiting frame and cancels active Image work and queued frames", async () => {
    const s = setup();
    vi.stubGlobal("createImageBitmap", undefined);
    const painter = createPreviewFramePainter(s.canvas, s.onPainted, s.onError);
    painter.paint(new ArrayBuffer(1));
    painter.paint(new ArrayBuffer(2));
    painter.paint(new ArrayBuffer(3));
    s.images[0]!.onload!();
    await flush();
    expect(s.images).toHaveLength(2);
    expect(s.createURL.mock.calls.map((call) => (call[0] as Blob).size)).toEqual([1, 3]);
    painter.paint(new ArrayBuffer(4));
    const lateLoad = s.images[1]!.onload!;
    painter.stop();
    lateLoad();
    await flush();
    expect(s.images).toHaveLength(2);
    expect(s.revokeURL).toHaveBeenCalledTimes(2);
    expect(s.images[1]!.src).toBe("");
    expect(s.images[1]!.onload).toBeNull();
    expect(s.images[1]!.onerror).toBeNull();
    expect(s.onPainted).toHaveBeenCalledOnce();
    expect(s.onError).not.toHaveBeenCalled();
  });

  it.each(["draw", "callback"])(
    "does not retry a %s exception through the Image decoder",
    async (phase) => {
      const s = setup();
      const error = new Error(`${phase} failed`);
      if (phase === "draw")
        s.context!.drawImage.mockImplementation(() => {
          throw error;
        });
      else
        s.onPainted.mockImplementation(() => {
          throw error;
        });
      const close = vi.fn();
      vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 2, height: 3, close }));
      const painter = createPreviewFramePainter(s.canvas, s.onPainted, s.onError);
      painter.paint(new ArrayBuffer(1));
      await flush();
      expect(s.context!.drawImage).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(s.images).toHaveLength(0);
      expect(s.onError).toHaveBeenCalledExactlyOnceWith(error);
      painter.stop();
    },
  );
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});
