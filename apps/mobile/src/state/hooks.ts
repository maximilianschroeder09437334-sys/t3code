import { HookDefinition, WS_METHODS } from "@t3tools/contracts";
import { persistQuery } from "@t3tools/client-runtime/state/query-persistence";
import * as Schema from "effect/Schema";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const hooksList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hooks:list",
  tag: WS_METHODS.hooksList,
  persistence: persistQuery(Schema.Array(HookDefinition)),
  staleTimeMs: 0,
  idleTtlMs: 5 * 60_000,
});

export const hookApprove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:hooks:approve",
  tag: WS_METHODS.hooksApprove,
});

export const hookUpdateDraft = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:hooks:update-draft",
  tag: WS_METHODS.hooksUpdateDraft,
});

export const hookSetEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:hooks:set-enabled",
  tag: WS_METHODS.hooksSetEnabled,
});
