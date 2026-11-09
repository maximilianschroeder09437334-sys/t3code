// Provider hooks are guardrails. Dynamic code and provider-hosted tools can bypass
// this classifier; the native session backend remains the authority for release.
export function computerUseOperation(toolName: string, input: unknown): "use" | "end" | null {
  if (/cua_repl[._]+js$/i.test(toolName)) {
    if (
      typeof input === "object" &&
      input !== null &&
      Object.keys(input).length === 1 &&
      "completion_summary" in input &&
      typeof input.completion_summary === "string" &&
      input.completion_summary.trim() !== ""
    )
      return "end";
    return "use";
  }
  if (/computer[-_]?use|(?:^|[._])sky(?:[._]|$)/i.test(toolName)) return "use";
  if (/node_repl|functions[._]+exec$/i.test(toolName)) {
    const code =
      typeof input === "object" && input !== null && "code" in input ? input.code : input;
    if (typeof code === "string" && /@oai\/sky|\bsky\s*[.[]|\bcua\s*[.[]/.test(code)) return "use";
  }
  return null;
}

export function codexHookBridgeConfig() {
  const handler = (event: "before_tool" | "after_tool") => ({
    type: "mcp_tool",
    server: "t3-code",
    tool: "t3_hook_event",
    input: { event, toolName: "${tool_name}", toolInput: "${tool_input}" },
    timeout: 10,
    statusMessage: "Checking approved T3 safeguards",
  });
  return {
    description:
      "T3 hook bridge: requires exact human trust in Codex; unavailable hooks can fail open.",
    hooks: {
      PreToolUse: [{ matcher: ".*", hooks: [handler("before_tool")] }],
      PostToolUse: [{ matcher: ".*", hooks: [handler("after_tool")] }],
    },
  };
}
