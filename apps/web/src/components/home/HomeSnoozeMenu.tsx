import type { ScopedThreadRef } from "@t3tools/contracts";
import { ClockIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { pickSnoozePreset, resolveSnoozePresets } from "../Sidebar.snooze";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuTrigger } from "../ui/menu";

export function HomeSnoozeMenu(props: { threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const [open, setOpen] = useState(false);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { snoozeThread } = useThreadActions();
  const presets = open
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, threadRef.environmentId)
    : [];
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={<Button size="xs" variant="ghost" />}>
        <ClockIcon />
        Snooze
      </MenuTrigger>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={() => {
              const picked = pickSnoozePreset(
                presets,
                preset.id,
                timestampFormat,
                threadRef.environmentId,
              );
              if (picked) void snoozeThread(threadRef, picked.snoozedUntil);
            }}
          >
            {preset.label}
            <MenuItemDetail>{preset.whenLabel}</MenuItemDetail>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
