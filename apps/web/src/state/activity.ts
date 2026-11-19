import { createActivityAtoms } from "@t3tools/client-runtime/state/activity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { environmentThreadShells } from "./threads";

export const overview = createActivityAtoms(connectionAtomRuntime, {
  presentationsAtom: environmentPresentations.presentationsAtom,
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
});
