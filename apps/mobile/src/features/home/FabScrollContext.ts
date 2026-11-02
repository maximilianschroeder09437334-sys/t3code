import { createContext, useContext } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

export const FloatingUsageContext = createContext(false);

export function useFloatingUsage() {
  return useContext(FloatingUsageContext);
}

export const FabScrollContext = createContext<
  ((event: NativeSyntheticEvent<NativeScrollEvent>) => void) | undefined
>(undefined);

export function useFabScroll() {
  return useContext(FabScrollContext);
}
