import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { View } from "react-native";

import { ScreenContent } from "../../components/ui/ScreenContent";
import { ThreadDetailScreen, type ThreadDetailScreenProps } from "./ThreadDetailScreen";

type ThreadScreenContent =
  | { readonly props: ThreadDetailScreenProps }
  | { readonly fallback: ReactNode; readonly header?: ReactNode };

function createThreadScreenStore() {
  let current: ThreadScreenContent | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (content: ThreadScreenContent) => {
      current = content;
      for (const listener of listeners) listener();
    },
  };
}
const ThreadScreenContext = createContext<ReturnType<typeof createThreadScreenStore> | null>(null);

const ThreadOverlayContext = createContext<ReturnType<typeof createThreadOverlayStore> | null>(
  null,
);

function createThreadOverlayStore() {
  let current: ReactNode = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (overlay: ReactNode) => {
      current = overlay;
      for (const listener of listeners) listener();
    },
  };
}

function ThreadOverlayOutlet() {
  const store = useContext(ThreadOverlayContext)!;
  const overlay = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return overlay === null ? null : (
    <View
      testID="thread-content-overlay"
      style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 20 }}
    >
      {overlay}
    </View>
  );
}

/** Publish into this thread's content area, below its actual AppBar in detail and split layouts. */
export function ThreadScreenOverlay({ children }: { readonly children: ReactNode }) {
  const store = useContext(ThreadOverlayContext)!;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds the header-controlled pane to its host's below-header slot
  useLayoutEffect(() => {
    store.publish(children);
    return () => store.publish(null);
  }, [store, children]);
  return null;
}

function ThreadScreenOutlet() {
  const store = useContext(ThreadScreenContext)!;
  const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (content === null) return null;
  const body = "props" in content ? <ThreadDetailScreen {...content.props} /> : content.fallback;
  return (
    <>
      {"props" in content ? content.props.header : content.header}
      <View testID="thread-content-area" style={{ flex: 1 }}>
        <ScreenContent surface="canvas">{body}</ScreenContent>
        <ThreadOverlayOutlet />
      </View>
    </>
  );
}

// Controllers can change from draft to live without replacing the native screen,
// the keyboard host, or the editor. Publish before paint to avoid an intermediate frame.
export function ThreadScreenHost({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createThreadScreenStore);
  const [overlayStore] = useState(createThreadOverlayStore);
  return (
    <ThreadScreenContext.Provider value={store}>
      <ThreadOverlayContext.Provider value={overlayStore}>
        {children}
        <View className="flex-1 bg-screen android:bg-header">
          <ThreadScreenOutlet />
        </View>
      </ThreadOverlayContext.Provider>
    </ThreadScreenContext.Provider>
  );
}

export function ThreadScreenBinding(props: ThreadDetailScreenProps) {
  const store = useContext(ThreadScreenContext)!;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the route's thread screen props to the external store the outlet reads
  useLayoutEffect(() => {
    store.publish({ props });
  });
  return null;
}

export function ThreadScreenFallback({
  children,
  header,
}: {
  readonly children: ReactNode;
  readonly header?: ReactNode;
}) {
  const store = useContext(ThreadScreenContext)!;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the fallback content and header to the external store the outlet reads
  useLayoutEffect(() => {
    store.publish({ fallback: children, header });
  });
  return null;
}
