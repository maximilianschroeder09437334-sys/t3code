import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { selectedThreadRowColors } from "./thread-list-v2-row-appearance";

/** The yellow pen-and-"Draft" tag a thread row shows while its composer holds unsent text. */
export function ThreadDraftTag(props: {
  readonly selected?: boolean;
  /** Centres the tag on the row's first title line. */
  readonly minHeight?: number;
}) {
  return (
    <View
      accessibilityLabel="Unsent draft"
      className="flex-row items-center gap-1"
      style={props.minHeight === undefined ? undefined : { minHeight: props.minHeight }}
    >
      <SymbolView
        name="square.and.pencil"
        size={13}
        tintColorClassName={
          props.selected
            ? selectedThreadRowColors.iconTintClassName
            : "accent-adaptive-amber-700-300"
        }
        type="monochrome"
        weight="semibold"
      />
      <Text
        className={cn(
          "text-xs font-t3-bold",
          props.selected
            ? selectedThreadRowColors.foregroundClassName
            : "text-adaptive-amber-700-300",
        )}
      >
        Draft
      </Text>
    </View>
  );
}
