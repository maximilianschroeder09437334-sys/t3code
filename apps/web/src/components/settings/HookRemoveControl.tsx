import type { HookDefinition } from "@t3tools/contracts";
import { Button } from "../ui/button";

export function HookRemoveControl({
  hook,
  supported,
  disabled,
  onRemove,
}: {
  readonly hook: Pick<HookDefinition, "enabled" | "name">;
  readonly supported: boolean;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  if (hook.enabled || !supported) return null;
  return (
    <Button
      variant="ghost-destructive"
      size="sm"
      disabled={disabled}
      aria-label={`Remove ${hook.name}`}
      onClick={onRemove}
    >
      Remove
    </Button>
  );
}
