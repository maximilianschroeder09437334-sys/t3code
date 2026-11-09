import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const webPushInfo = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "notifications:info",
  tag: WS_METHODS.webPushInfo,
  staleTimeMs: 0,
});
export const webPushPrepare = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "notifications:prepare",
  tag: WS_METHODS.webPushPrepare,
});
export const webPushSubscribe = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "notifications:subscribe",
  tag: WS_METHODS.webPushSubscribe,
});
export const webPushUnsubscribe = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "notifications:unsubscribe",
  tag: WS_METHODS.webPushUnsubscribe,
});
export const webPushTest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "notifications:test",
  tag: WS_METHODS.webPushTest,
});
