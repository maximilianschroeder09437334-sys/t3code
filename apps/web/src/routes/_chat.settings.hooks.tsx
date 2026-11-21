import { createFileRoute } from "@tanstack/react-router";
import { HooksSettingsPanel } from "../components/settings/HooksSettingsPanel";

export const Route = createFileRoute("/_chat/settings/hooks")({
  component: HooksSettingsPanel,
});
