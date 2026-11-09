export function shouldNotifyThread(input: {
  readonly kind: "input" | "completion" | "failure";
  readonly muted?: boolean | undefined;
  readonly humanAuthored?: boolean | undefined;
  readonly explicitPing?: boolean | undefined;
}): boolean {
  return (
    input.kind === "input" ||
    input.explicitPing === true ||
    input.muted === false ||
    input.humanAuthored === true
  );
}
