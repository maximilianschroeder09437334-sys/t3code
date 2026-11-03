import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadNotesRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-notes:read",
  tag: WS_METHODS.threadNotesRead,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
});
export const threadNotesSave = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-notes:save",
  tag: WS_METHODS.threadNotesSave,
});
export const threadNotesDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-notes:delete",
  tag: WS_METHODS.threadNotesDelete,
});
export const threadNotePersistScreenshot = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-notes:persist-screenshot",
  tag: WS_METHODS.assetsPersistChatAttachments,
});
