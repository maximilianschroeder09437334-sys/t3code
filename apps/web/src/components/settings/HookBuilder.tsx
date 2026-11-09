import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  HOOK_EVENT_COVERAGE,
  HookEvent,
  HookRecipe,
  type EnvironmentId,
  type HookCondition,
  type ProjectId,
} from "@t3tools/contracts";
import { compileHookRecipe, hookRecipeTemplates } from "@t3tools/shared/hookRecipe";
import { codexHookBridgeConfig } from "@t3tools/shared/hookToolBridge";
import { randomUUID } from "~/lib/utils";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { hookCreateDraft } from "~/state/hooks";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";

type EditableCondition = HookCondition & { readonly uiId: string };
type EditableRecipe = Omit<HookRecipe, "when" | "check"> & {
  readonly when: readonly EditableCondition[];
  readonly check: readonly EditableCondition[];
};
function editableRecipe(recipe: HookRecipe): EditableRecipe {
  return {
    ...recipe,
    when: recipe.when.map((condition) => ({ ...condition, uiId: randomUUID() })),
    check: recipe.check.map((condition) => ({ ...condition, uiId: randomUUID() })),
  };
}

function conditionValue(text: string): string | number | boolean | null {
  try {
    const value: unknown = JSON.parse(text);
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "string"
    )
      return value;
  } catch {
    /* Unquoted text is a string value. */
  }
  return text;
}
function Conditions({
  label,
  conditions,
  onChange,
}: {
  readonly label: string;
  readonly conditions: readonly EditableCondition[];
  readonly onChange: (conditions: readonly EditableCondition[]) => void;
}) {
  const update = (index: number, patch: Partial<HookCondition>) =>
    onChange(
      conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
    );
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      {conditions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {label === "When" ? "Every matching event." : "No conditions yet."}
        </p>
      ) : null}
      {conditions.map((condition, index) => (
        <div key={condition.uiId} className="flex flex-wrap items-center gap-2">
          <div className="min-w-36 flex-1">
            <Input
              aria-label={`${label} field ${index + 1}`}
              placeholder="Payload field, e.g. branch"
              value={condition.path}
              onChange={(event) => update(index, { path: event.target.value })}
            />
          </div>
          <Select
            value={condition.operator}
            onValueChange={(operator) => {
              if (operator !== null) update(index, { operator });
            }}
          >
            <SelectTrigger aria-label={`${label} comparison ${index + 1}`} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {["equals", "not-equals", "includes", "exists", "at-least", "at-most"].map(
                (value) => (
                  <SelectItem key={value} value={value}>
                    {value.replaceAll("-", " ")}
                  </SelectItem>
                ),
              )}
            </SelectPopup>
          </Select>
          <div className="min-w-24 flex-1">
            <Input
              aria-label={`${label} value ${index + 1}`}
              placeholder="Value"
              value={
                typeof condition.value === "string"
                  ? condition.value
                  : JSON.stringify(condition.value ?? "")
              }
              onChange={(event) => update(index, { value: conditionValue(event.target.value) })}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(conditions.filter((_, i) => i !== index))}
            aria-label={`Remove ${label.toLowerCase()} condition ${index + 1}`}
          >
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={conditions.length >= 20}
          onClick={() =>
            onChange([
              ...conditions,
              { path: "", operator: "equals", value: "", uiId: randomUUID() },
            ])
          }
        >
          Add condition
        </Button>
      </div>
    </fieldset>
  );
}

export function HookBuilder({
  environmentId,
  projectId,
  scope,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly scope: "project" | "all-projects";
  readonly onSaved: () => void;
}) {
  const [recipe, setRecipe] = useState<EditableRecipe>(() =>
    editableRecipe(hookRecipeTemplates[0]!.recipe),
  );
  const [name, setName] = useState(hookRecipeTemplates[0]!.name);
  const [expert, setExpert] = useState(false);
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const createDraft = useAtomCommand(hookCreateDraft, "save inactive hook draft");
  const canCreate = useAtomValue(hookCreateDraft.permissionAtom(environmentId));
  let generated = "";
  let invalid: string | null = null;
  try {
    generated = compileHookRecipe(decodeRecipe(recipe));
  } catch (error) {
    invalid = error instanceof Error ? error.message : "Complete the recipe fields.";
  }
  const save = async () => {
    if (busy || !canCreate || (!expert && invalid !== null)) return;
    setBusy(true);
    setFeedback(null);
    const result = await createDraft({
      environmentId,
      input: { projectId, scope, name, event: recipe.event, script: expert ? script : generated },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setFeedback(String(squashAtomCommandFailure(result)));
      return;
    }
    setFeedback(
      "Saved an inactive draft. Review the exact script, event and scope below before approving.",
    );
    onSaved();
  };
  return (
    <div className="flex min-w-0 flex-col gap-5 px-4 py-5">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Build a hook</h3>
        <p className="text-sm text-muted-foreground">
          Start with a template, edit its checks, and save a draft for review.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {hookRecipeTemplates.map((template) => (
          <Button
            key={template.id}
            variant="outline"
            size="sm"
            onClick={() => {
              setRecipe(editableRecipe(template.recipe));
              setName(template.name);
              setExpert(false);
              setFeedback(null);
            }}
          >
            {template.name}
          </Button>
        ))}
      </div>
      <label className="flex flex-col gap-2 text-sm">
        Name
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="flex flex-col gap-2 text-sm">
        Event
        <Select
          value={recipe.event}
          onValueChange={(event) => {
            if (isHookEvent(event)) setRecipe({ ...recipe, event });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {HookEvent.literals.map((event) => (
              <SelectItem key={event} value={event}>
                {event.replaceAll("_", " ")}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      <p className="text-sm text-muted-foreground" role="note">
        Coverage: {HOOK_EVENT_COVERAGE[recipe.event].level}.{" "}
        {HOOK_EVENT_COVERAGE[recipe.event].boundary}
      </p>
      {recipe.event === "before_tool" ||
      recipe.event === "after_tool" ||
      recipe.event.startsWith("resource_") ? (
        <details>
          <summary className="cursor-pointer text-sm">Provider bridge setup and limits</summary>
          <p className="mt-3 text-sm text-muted-foreground">
            Codex must load and trust this exact bridge separately. Merge it with existing hooks;
            review it in Codex /hooks. Hosted tools and unavailable hook servers may bypass it.
            Timer expiry does not prove the native backend ended.
          </p>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(codexHookBridgeConfig(), null, 2)}
          </pre>
        </details>
      ) : null}
      <label className="flex items-center justify-between gap-3 text-sm">
        Expert JavaScript
        <Switch
          checked={expert}
          onCheckedChange={(checked) => {
            setExpert(checked);
            if (checked && script === "") setScript(generated);
          }}
        />
      </label>
      {expert ? (
        <label className="flex flex-col gap-2 text-sm">
          Script
          <Textarea
            value={script}
            onChange={(event) => setScript(event.target.value)}
            rows={12}
            spellCheck={false}
          />
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-2 text-sm">
            What it does
            <Input
              value={recipe.description}
              onChange={(event) => setRecipe({ ...recipe, description: event.target.value })}
            />
          </label>
          <Conditions
            label="When"
            conditions={recipe.when}
            onChange={(when) => setRecipe({ ...recipe, when })}
          />
          <Conditions
            label="Check"
            conditions={recipe.check}
            onChange={(check) => setRecipe({ ...recipe, check })}
          />
          <label className="flex flex-col gap-2 text-sm">
            If a check fails
            <Select
              value={recipe.onFailure}
              onValueChange={(onFailure) => {
                if (onFailure !== null)
                  setRecipe({
                    ...recipe,
                    onFailure,
                    ...(onFailure === "repair" && recipe.repair === undefined
                      ? {
                          repair: {
                            prompt:
                              "Repair the authorized step and verify the result. Preserve Stop and approval limits.",
                            maxAttempts: 2,
                            deadlineSeconds: 300,
                          },
                        }
                      : {}),
                  });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="block">Block this action</SelectItem>
                <SelectItem value="warn">Warn and continue</SelectItem>
                <SelectItem value="repair">Repair and verify within limits</SelectItem>
              </SelectPopup>
            </Select>
          </label>
          <label className="flex flex-col gap-2 text-sm">
            Feedback to the agent
            <Textarea
              rows={2}
              value={recipe.message}
              onChange={(event) => setRecipe({ ...recipe, message: event.target.value })}
            />
          </label>
          {recipe.onFailure === "repair" && recipe.repair !== undefined ? (
            <div className="flex flex-col gap-3 text-sm">
              <label className="flex flex-col gap-2">
                Repair instruction
                <Textarea
                  rows={3}
                  value={recipe.repair.prompt}
                  onChange={(event) =>
                    setRecipe({
                      ...recipe,
                      repair: { ...recipe.repair!, prompt: event.target.value },
                    })
                  }
                />
              </label>
              <label className="flex flex-col gap-2">
                Maximum attempts
                <Input
                  type="number"
                  min={1}
                  max={2}
                  value={recipe.repair.maxAttempts}
                  onChange={(event) =>
                    setRecipe({
                      ...recipe,
                      repair: { ...recipe.repair!, maxAttempts: Number(event.target.value) },
                    })
                  }
                />
              </label>
              <label className="flex flex-col gap-2">
                Time limit in seconds
                <Input
                  type="number"
                  min={1}
                  max={300}
                  value={recipe.repair.deadlineSeconds}
                  onChange={(event) =>
                    setRecipe({
                      ...recipe,
                      repair: { ...recipe.repair!, deadlineSeconds: Number(event.target.value) },
                    })
                  }
                />
              </label>
              {recipe.event === "thread_stalled" ? (
                <label className="flex items-center justify-between gap-3">
                  Resume idle unfinished work
                  <Switch
                    checked={recipe.repair.allowIdleResume === true}
                    onCheckedChange={(allowIdleResume) =>
                      setRecipe({ ...recipe, repair: { ...recipe.repair!, allowIdleResume } })
                    }
                  />
                </label>
              ) : null}
              <span className="text-muted-foreground">
                Human Stop, questions, queues, permissions and usage limits always win.
              </span>
            </div>
          ) : null}
          <details>
            <summary className="cursor-pointer text-sm">Review generated script</summary>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">
              {generated}
            </pre>
          </details>
        </>
      )}
      {invalid !== null && !expert ? (
        <p role="alert" className="text-sm text-destructive">
          {invalid}
        </p>
      ) : null}
      {feedback !== null ? (
        <p role="status" className="text-sm">
          {feedback}
        </p>
      ) : null}
      <div>
        <Button
          disabled={
            busy ||
            !canCreate ||
            name.trim() === "" ||
            (expert ? script.trim() === "" : invalid !== null)
          }
          onClick={() => void save()}
        >
          {busy ? "Saving draft…" : "Save inactive draft"}
        </Button>
      </div>
    </div>
  );
}

const decodeRecipe = Schema.decodeSync(HookRecipe);

const isHookEvent = Schema.is(HookEvent);
