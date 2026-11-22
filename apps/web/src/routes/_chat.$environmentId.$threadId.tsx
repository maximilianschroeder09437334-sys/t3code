import { createFileRoute } from "@tanstack/react-router";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  // `item` reveals one turn item, e.g. a subagent a waiting thread is waiting on.
  validateSearch: (raw: Record<string, unknown>): { item?: string } =>
    typeof raw.item === "string" ? { item: raw.item } : {},
  component: () => null,
});
