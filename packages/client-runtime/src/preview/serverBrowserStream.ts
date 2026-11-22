// @effect-diagnostics globalTimers:off globalFetch:off - This browser and WebView transport runs without an Effect runtime.
import { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";
import {
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  type PreviewStreamHostSetup,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

export const PREVIEW_STREAM_BASE_PATH = "/api/preview-stream";

export interface PreviewStreamViewport {
  readonly width: number;
  readonly height: number;
  readonly isActiveSizer?: boolean;
}

export type PreviewStreamMouseButton = "none" | "left" | "middle" | "right";

export interface PreviewStreamControl {
  readonly canOperate: boolean;
  readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
  readonly generation: number;
  readonly dialog: null | {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
}

export const previewStreamControlLabel = (control: PreviewStreamControl | null): string =>
  !control
    ? "Connecting..."
    : !control.canOperate
      ? "Read-only"
      : control.controller === "you"
        ? "You have control"
        : control.controller === "agent"
          ? "Agent has control"
          : control.controller === "another-viewer"
            ? "Another viewer has control"
            : "Watching";

const isPreviewStreamDialog = (value: unknown): value is PreviewStreamControl["dialog"] =>
  value === null ||
  (typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "defaultValue" in value &&
    typeof value.defaultValue === "string");

/** Coordinates are page CSS px. */
export type PreviewStreamInput =
  | { readonly type: "takeControl" }
  | { readonly type: "releaseControl" }
  | { readonly type: "dialog"; readonly accept: boolean; readonly promptText?: string }
  | { readonly type: "viewport"; readonly setting: PreviewViewportSetting }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: PreviewStreamMouseButton;
      /** Pressed buttons: left 1, right 2, middle 4. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      /** Windows virtual key code (DOM `keyCode`); Enter, Backspace, and arrows need it. */
      readonly keyCode?: number;
      /** Only for printable keys without Ctrl or Meta. */
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload"; readonly ignoreCache?: boolean }
  | { readonly type: "stopLoading" }
  | { readonly type: "probe"; readonly x: number; readonly y: number };

export interface PreviewStreamDownload {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Authenticated with the stream's own access; cookie sessions must send credentials. */
  readonly url: string;
}

export interface PreviewStreamFileChooser {
  readonly multiple: boolean;
  readonly accept: string;
  /** POST multipart `file` parts here; an empty form cancels the page's picker. */
  readonly uploadUrl: string;
  readonly credentials: boolean;
}

const previewStreamUploadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  chooser: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/upload?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      chooser,
    }).toString()}`,
    target.access,
  );

export async function uploadPreviewStreamFiles(
  chooser: PreviewStreamFileChooser,
  files: ReadonlyArray<Blob & { readonly name?: string }>,
): Promise<void> {
  const body = new FormData();
  for (const file of files) body.append("file", file, file.name ?? "file");
  const response = await fetch(chooser.uploadUrl, {
    method: "POST",
    body,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

export const previewStreamDownloadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  id: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/download?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      id,
    }).toString()}`,
    target.access,
  );

export interface PreviewStreamProbe {
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
}

export interface PreviewStreamPointer {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
}

export const previewStreamModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export interface PreviewStreamTarget {
  readonly access: DeviceHubAccess;
  readonly threadId: string;
  readonly tabId: string;
  /** Viewer backing-store size in device px. The server never sends larger frames. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Emulates a touch-first phone viewport while this viewer owns the page size. */
  readonly mobile?: boolean;
  /** The physical-pixel ratio for this viewer's CSS viewport. */
  readonly deviceScaleFactor?: number;
  /** Identifies the desktop app's own browser panel so its native size can be restored on input. */
  readonly localDesktop?: boolean;
  /** Passive viewers reduce their own access, including automatic control grants. */
  readonly interactive?: boolean;
}

export interface PreviewStreamEvents {
  readonly onFrame: (jpeg: ArrayBuffer) => void;
  readonly onViewport: (viewport: PreviewStreamViewport) => void;
  readonly onProbe?: (probe: PreviewStreamProbe) => void;
  readonly onPointer?: (pointer: PreviewStreamPointer) => void;
  readonly onControl?: (control: PreviewStreamControl) => void;
  readonly onClipboard?: (text: string) => void;
  readonly onDownload?: (download: PreviewStreamDownload) => void;
  readonly onPopup?: (tabId: string) => void;
  readonly onFileChooser?: (chooser: PreviewStreamFileChooser | null) => void;
  readonly onConnectedChange: (connected: boolean) => void;
  /** The upgrade was refused; refresh access and start a new client. */
  readonly onUnauthorized: () => void;
  readonly onGone?: () => void;
  readonly onHostSetup?: (setup: PreviewStreamHostSetup) => void;
}

export interface PreviewStreamClient {
  readonly send: (input: PreviewStreamInput) => boolean;
  readonly stop: () => void;
}

const ACK_MESSAGE = JSON.stringify({ type: "ack" });
export function createPreviewStreamClient(
  target: PreviewStreamTarget,
  events: PreviewStreamEvents,
): PreviewStreamClient {
  const query = new URLSearchParams({
    threadId: target.threadId,
    tabId: target.tabId,
    maxWidth: String(Math.max(1, Math.round(target.maxWidth))),
    maxHeight: String(Math.max(1, Math.round(target.maxHeight))),
  });
  if (target.interactive === false) query.set("interactive", "false");
  if (target.mobile) query.set("mobile", "true");
  if (target.localDesktop) query.set("localDesktop", "true");
  if (target.deviceScaleFactor !== undefined) {
    query.set("deviceScaleFactor", String(Math.max(1, Math.min(4, target.deviceScaleFactor))));
  }
  const url = withDeviceHubQuery(`${target.access.wsBase}/ws?${query.toString()}`, target.access);
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: PreviewStreamControl | null = null;
  let fileChooser: string | null = null;

  // The server re-offers a picker still open, under a new id, when this viewer reattaches.
  const withdrawFileChooser = () => {
    if (fileChooser === null) return;
    fileChooser = null;
    events.onFileChooser?.(null);
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        ws.send(ACK_MESSAGE);
        events.onFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const {
        type,
        x,
        y,
        width,
        height,
        editable,
        canOperate,
        controller,
        generation,
        dialog,
        text,
        id,
        fileName,
        sizeBytes,
        multiple,
        accept,
        phase,
        sequence,
        tabId,
        isActiveSizer,
      } = message as Record<string, unknown>;
      if (
        type === "fileChooser" &&
        typeof id === "string" &&
        typeof multiple === "boolean" &&
        typeof accept === "string"
      ) {
        fileChooser = id;
        events.onFileChooser?.({
          multiple,
          accept,
          uploadUrl: previewStreamUploadUrl(target, id),
          credentials: target.access.credentials,
        });
      } else if (type === "fileChooserClosed" && typeof id === "string") {
        if (fileChooser !== id) return;
        fileChooser = null;
        events.onFileChooser?.(null);
      } else if (
        type === "pointer" &&
        (phase === "move" || phase === "click") &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof sequence === "number"
      ) {
        events.onPointer?.({ phase, x, y, sequence });
      } else if (type === "popup" && typeof tabId === "string") {
        events.onPopup?.(tabId);
      } else if (type === "clipboard" && typeof text === "string") {
        events.onClipboard?.(text);
      } else if (
        type === "download" &&
        typeof id === "string" &&
        typeof fileName === "string" &&
        typeof sizeBytes === "number"
      ) {
        events.onDownload?.({
          fileName,
          sizeBytes,
          url: previewStreamDownloadUrl(target, id),
        });
      } else if (type === "viewport" && typeof width === "number" && typeof height === "number") {
        failures = 0;
        events.onViewport({ width, height, isActiveSizer: isActiveSizer === true });
      } else if (
        type === "probe" &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof editable === "boolean"
      ) {
        events.onProbe?.({ x, y, editable });
      } else if (
        type === "control" &&
        typeof canOperate === "boolean" &&
        (controller === "agent" ||
          controller === "you" ||
          controller === "another-viewer" ||
          controller === "unclaimed") &&
        typeof generation === "number" &&
        isPreviewStreamDialog(dialog)
      ) {
        const nextControl: PreviewStreamControl = {
          canOperate,
          controller,
          generation,
          dialog,
        };
        control = nextControl;
        events.onControl?.(nextControl);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      withdrawFileChooser();
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      if (event.code === 4404) {
        stopped = true;
        events.onGone?.();
        return;
      }
      if (event.code === PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE) {
        stopped = true;
        events.onHostSetup?.(decodeHostSetup(event.reason));
        return;
      }
      // Rejected upgrades surface as 1006 before open for both cookies and tickets.
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) {
        stopped = true;
        events.onUnauthorized();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
    });
    ws.addEventListener("error", () => ws.close());
  };

  connect();

  return {
    send: (input) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (!control?.canOperate) return false;
      if (input.type !== "takeControl" && control.controller !== "you") return false;
      socket.send(JSON.stringify(input));
      return true;
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      control = null;
      withdrawFileChooser();
      ws?.close();
    },
  };
}

export interface PreviewFramePainter {
  readonly paint: (jpeg: ArrayBuffer) => void;
  readonly stop: () => void;
}

/** One decode at a time, keeping only the latest waiting frame for slow viewers. */
export function createPreviewFramePainter(
  canvas: HTMLCanvasElement,
  onPainted?: () => void,
  onError?: (error: Error) => void,
): PreviewFramePainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let decoding = false;
  let waiting: ArrayBuffer | null = null;
  let cancelFallback: (() => void) | null = null;
  const paintSource = (source: CanvasImageSource, width: number, height: number) => {
    if (stopped) return;
    if (!context) throw new Error("The preview canvas has no 2D drawing context.");
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(source, 0, 0);
    onPainted?.();
  };
  const draw = (jpeg: ArrayBuffer) => {
    decoding = true;
    const blob = new Blob([jpeg], { type: "image/jpeg" });
    const fallback = (bitmapError?: unknown) =>
      new Promise<void>((resolve, reject) => {
        if (stopped) {
          resolve();
          return;
        }
        const image = new Image();
        const url = URL.createObjectURL(blob);
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          image.onload = null;
          image.onerror = null;
          image.src = "";
          URL.revokeObjectURL(url);
          cancelFallback = null;
        };
        cancelFallback = () => {
          cleanup();
          resolve();
        };
        image.onload = () => {
          try {
            paintSource(image, image.naturalWidth, image.naturalHeight);
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            reject(error);
          }
        };
        image.onerror = () => {
          cleanup();
          const detail =
            bitmapError instanceof Error ? ` Bitmap decoder: ${bitmapError.message}` : "";
          reject(new Error(`The browser could not decode the preview JPEG.${detail}`));
        };
        image.src = url;
      });
    const decode =
      typeof createImageBitmap === "function"
        ? Promise.resolve()
            .then(() => (stopped ? null : createImageBitmap(blob)))
            .then(
              (bitmap) => {
                try {
                  if (bitmap) paintSource(bitmap, bitmap.width, bitmap.height);
                } finally {
                  bitmap?.close();
                }
              },
              (error: unknown) => fallback(error),
            )
        : fallback();
    void decode
      .then(() => undefined)
      .catch((cause: unknown) => {
        if (!stopped) onError?.(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped) draw(next);
      });
  };
  return {
    paint: (jpeg) => {
      if (stopped) return;
      if (decoding) waiting = jpeg;
      else draw(jpeg);
    },
    stop: () => {
      stopped = true;
      waiting = null;
      cancelFallback?.();
    },
  };
}

const decodeHostSetup = (reason: string): PreviewStreamHostSetup => {
  try {
    const value = JSON.parse(reason) as Partial<PreviewStreamHostSetup>;
    if (
      (value.need === "sandbox" || value.need === "libraries") &&
      typeof value.command === "string"
    ) {
      return { need: value.need, command: value.command };
    }
  } catch {}
  return { need: "sandbox", command: "sudo npx t3 browser setup" };
};

export const previewStreamHostSetupMessage = (setup: PreviewStreamHostSetup) =>
  setup.need === "sandbox"
    ? "This server's host blocks the sandbox its browser runs in. Run this once on the host, then try again:"
    : "This server's host is missing libraries its browser needs. Run this once on the host, then try again:";
