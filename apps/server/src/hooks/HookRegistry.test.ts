// @effect-diagnostics nodeBuiltinImport:off
import { it, expect, describe } from "@effect/vitest";
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProjectId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as HookRegistry from "./HookRegistry.ts";
import * as HookScriptRunner from "./HookScriptRunner.ts";

const layerTest = HookRegistry.layer.pipe(
  Layer.provide(HookScriptRunner.layer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-hooks-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it("keeps new hook events out of responses to older clients", () => {
  const base = {
    id: "old",
    projectId: ProjectId.make("compatibility"),
    name: "old",
    event: "turn_end" as const,
    script: "",
    scriptSha256: "0".repeat(64),
    status: "draft" as const,
    enabled: false,
    createdAt: 0,
  };
  const browser = { ...base, id: "browser", event: "before_browser_action" as const };
  expect(HookRegistry.hooksVisibleToClient([base, browser])).toEqual([base]);
  expect(
    HookRegistry.hooksVisibleToClient([base, browser], ["turn_end", "before_browser_action"]),
  ).toEqual([base, browser]);
});

describe("HookRegistry", () => {
  it.layer(layerTest, { excludeTestServices: true })("draft and approval lifecycle", (it) => {
    it.effect("blocks an active hook whose stored script no longer matches its approved hash", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const projectId = ProjectId.make("tampered-hook-project");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Review integrity",
          event: "turn_end",
          script: 'return { decision: "allow" };',
        });
        yield* registry.approve({
          projectId,
          hookId: draft.id,
          reviewedSha256: draft.scriptSha256,
        });
        const registryFile = nodePath.join(
          config.stateDir,
          "hooks",
          "projects",
          createHash("sha256").update(projectId).digest("hex") + ".json",
        );
        const raw = yield* fs.readFileString(registryFile);
        const state = JSON.parse(raw) as { hooks: Array<{ script: string; event: string }> };
        state.hooks[0]!.script = 'return { decision: "allow", message: "changed" };';
        yield* fs.writeFileString(registryFile, JSON.stringify(state));
        const result = yield* registry.runEvent({ projectId, event: "turn_end", payload: {} });
        expect(result.allowed).toBe(false);
        expect(result.messages[0]).toContain("approved script");
        state.hooks[0]!.script = draft.script;
        state.hooks[0]!.event = "before_file_write";
        yield* fs.writeFileString(registryFile, JSON.stringify(state));
        const changedEvent = yield* registry.runEvent({
          projectId,
          event: "before_file_write",
          payload: {},
        });
        expect(changedEvent.allowed).toBe(false);
      }),
    );
    it.effect("runs an approved shared hook in existing and future projects", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const author = ProjectId.make("shared-hook-author");
        const other = ProjectId.make("shared-hook-future-project");
        const draft = yield* registry.createDraft({
          projectId: author,
          scope: "all-projects",
          name: "Shared guard",
          event: "before_file_write",
          script: 'return { decision: "block", message: "Shared guard" };',
        });
        expect(draft.scope).toBe("all-projects");
        expect((yield* registry.list(other)).map((hook) => hook.id)).toContain(draft.id);
        expect(
          (yield* registry.runEvent({ projectId: other, event: "before_file_write", payload: {} }))
            .allowed,
        ).toBe(true);
        const edited = yield* registry.updateDraft({
          projectId: other,
          hookId: draft.id,
          script: 'return { decision: "block", message: "Shared guard updated" };',
        });
        const stale = yield* registry
          .approve({
            projectId: author,
            hookId: draft.id,
            reviewedSha256: draft.scriptSha256,
          })
          .pipe(Effect.flip);
        expect(stale.reason).toBe("approval-mismatch");
        const missingScope = yield* registry
          .approve({ projectId: other, hookId: draft.id, reviewedSha256: edited.scriptSha256 })
          .pipe(Effect.flip);
        expect(missingScope.reason).toBe("approval-mismatch");
        const wrongEvent = yield* registry
          .approve({
            projectId: other,
            hookId: draft.id,
            reviewedSha256: edited.scriptSha256,
            reviewedEvent: "turn_end",
            reviewedScope: "all-projects",
          })
          .pipe(Effect.flip);
        expect(wrongEvent.reason).toBe("approval-mismatch");
        yield* registry.approve({
          projectId: other,
          hookId: draft.id,
          reviewedSha256: edited.scriptSha256,
          reviewedEvent: "before_file_write",
          reviewedScope: "all-projects",
        });
        expect(
          yield* registry.runEvent({ projectId: other, event: "before_file_write", payload: {} }),
        ).toEqual({ allowed: false, messages: ["Shared guard updated"] });
        expect(
          yield* registry.runEvent({ projectId: author, event: "before_file_write", payload: {} }),
        ).toEqual({ allowed: false, messages: ["Shared guard updated"] });
        yield* registry.setEnabled({ projectId: other, hookId: draft.id, enabled: false });
        expect(
          (yield* registry.runEvent({ projectId: author, event: "before_file_write", payload: {} }))
            .allowed,
        ).toBe(true);
      }),
    );
    it.effect("runs only a draft whose exact script hash was approved", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const projectId = ProjectId.make("hook-project-a");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Guard file writes",
          event: "before_file_write",
          script:
            'if (input.payload.path === "protected.txt") return { decision: "block", message: "Protected path" }; return { decision: "allow" };',
        });
        const pending = yield* registry.runEvent({
          projectId,
          event: "before_file_write",
          payload: { path: "protected.txt" },
        });
        expect(pending.allowed).toBe(true);

        const approved = yield* registry.approve({
          projectId,
          hookId: draft.id,
          reviewedSha256: draft.scriptSha256,
        });
        expect(approved.status).toBe("active");
        const blocked = yield* registry.runEvent({
          projectId,
          event: "before_file_write",
          payload: { path: "protected.txt" },
        });
        expect(blocked).toEqual({ allowed: false, messages: ["Protected path"] });
      }),
    );

    it.effect("rejects approval if the reviewed source hash is stale", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const projectId = ProjectId.make("hook-project-b");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Review me",
          event: "turn_end",
          script: 'return { decision: "allow" };',
        });
        const error = yield* registry
          .approve({
            projectId,
            hookId: draft.id,
            reviewedSha256: "0".repeat(64),
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("approval-mismatch");
      }),
    );

    it.effect("approves the existing T3 pre-push event", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const projectId = ProjectId.make("hook-pre-push-event");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Pre-push guard",
          event: "before_github_push",
          script: 'return { decision: "block" };',
        });
        const approved = yield* registry.approve({
          projectId,
          hookId: draft.id,
          reviewedSha256: draft.scriptSha256,
        });
        expect(approved.status).toBe("active");
      }),
    );

    it.effect("allows editing a draft and approves only the edited hash", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const projectId = ProjectId.make("hook-project-edit");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Editable draft",
          event: "before_file_write",
          script: 'return { decision: "allow" };',
        });
        const editedScript = 'return { decision: "block", message: "Edited" };';
        const updated = yield* registry.updateDraft({
          projectId,
          hookId: draft.id,
          script: editedScript,
        });

        expect(updated.status).toBe("draft");
        expect(updated.script).toBe(editedScript);
        expect(updated.scriptSha256).not.toBe(draft.scriptSha256);
        const staleApproval = yield* registry
          .approve({ projectId, hookId: draft.id, reviewedSha256: draft.scriptSha256 })
          .pipe(Effect.flip);
        expect(staleApproval.reason).toBe("approval-mismatch");

        yield* registry.approve({
          projectId,
          hookId: draft.id,
          reviewedSha256: updated.scriptSha256,
        });
        const result = yield* registry.runEvent({
          projectId,
          event: "before_file_write",
          payload: {},
        });
        expect(result).toEqual({ allowed: false, messages: ["Edited"] });
      }),
    );

    it.effect("fails closed on invalid script decisions", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const projectId = ProjectId.make("hook-project-c");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Invalid result",
          event: "turn_end",
          script: 'return { decision: "maybe" };',
        });
        yield* registry.approve({
          projectId,
          hookId: draft.id,
          reviewedSha256: draft.scriptSha256,
        });
        const result = yield* registry.runEvent({ projectId, event: "turn_end", payload: {} });
        expect(result.allowed).toBe(false);
      }),
    );

    it.effect(
      "combines continuation and staged-install requests but lets any blocking hook win",
      () =>
        Effect.gen(function* () {
          const registry = yield* HookRegistry.HookRegistry;
          const projectId = ProjectId.make("hook-continuation-composition");
          for (const [name, script] of [
            ["Install", 'return { decision: "allow", action: "install-staged-files" };'],
            ["Continue", 'return { decision: "allow", continueWork: true };'],
          ]) {
            const draft = yield* registry.createDraft({
              projectId,
              name: name!,
              event: "turn_end",
              script: script!,
            });
            yield* registry.approve({
              projectId,
              hookId: draft.id,
              reviewedSha256: draft.scriptSha256,
            });
          }
          expect(yield* registry.runEvent({ projectId, event: "turn_end", payload: {} })).toEqual({
            allowed: true,
            messages: [],
            action: "install-staged-files",
            continueWork: true,
          });
          const block = yield* registry.createDraft({
            projectId,
            name: "Stop",
            event: "turn_end",
            script: 'return { decision: "block", message: "No" };',
          });
          yield* registry.approve({
            projectId,
            hookId: block.id,
            reviewedSha256: block.scriptSha256,
          });
          expect(
            (yield* registry.runEvent({ projectId, event: "turn_end", payload: {} })).allowed,
          ).toBe(false);
        }),
    );

    it.effect("requests continuation only for a Codex-owned first step", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const projectId = ProjectId.make("hook-continuation-condition");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Continue Codex-owned work",
          event: "turn_end",
          script:
            'if (input.payload?.firstNextStepOwner === "codex") return { decision: "allow", continueWork: true }; return { decision: "allow" };',
        });
        yield* registry.approve({
          projectId,
          hookId: draft.id,
          reviewedSha256: draft.scriptSha256,
        });
        expect(
          yield* registry.runEvent({
            projectId,
            event: "turn_end",
            payload: { firstNextStepOwner: "codex" },
          }),
        ).toEqual({ allowed: true, messages: [], continueWork: true });
        expect(
          yield* registry.runEvent({
            projectId,
            event: "turn_end",
            payload: { firstNextStepOwner: "maxi" },
          }),
        ).toEqual({ allowed: true, messages: [] });
      }),
    );

    it.effect("executes an approved browser recovery guard only for its event", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const projectId = ProjectId.make("browser-recovery-hook");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Browser recovery",
          event: "before_browser_action",
          script:
            'if (input.payload?.recoveryRequired && (!input.payload.statusChecked || !input.payload.snapshotChecked)) return { decision: "block", message: "Inspect status and snapshot first." }; return { decision: "allow" };',
        });
        yield* registry.approve({
          projectId,
          hookId: draft.id,
          reviewedSha256: draft.scriptSha256,
        });
        expect(
          (yield* registry.runEvent({
            projectId,
            event: "before_browser_action",
            payload: { recoveryRequired: true, statusChecked: true, snapshotChecked: false },
          })).allowed,
        ).toBe(false);
        expect(
          (yield* registry.runEvent({
            projectId,
            event: "before_browser_action",
            payload: { recoveryRequired: true, statusChecked: true, snapshotChecked: true },
          })).allowed,
        ).toBe(true);
        expect(
          (yield* registry.runEvent({ projectId, event: "turn_end", payload: {} })).allowed,
        ).toBe(true);
      }),
    );

    it.effect("preserves the managed-worktree enforcement selected by an active start hook", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const projectId = ProjectId.make("hook-managed-worktree");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Keep provider writes in its managed worktree",
          event: "before_provider_turn_start",
          script: 'return { decision: "allow", enforcement: "managed-worktree" };',
        });
        yield* registry.approve({
          projectId,
          hookId: draft.id,
          reviewedSha256: draft.scriptSha256,
        });

        const result = yield* registry.runEvent({
          projectId,
          event: "before_provider_turn_start",
          payload: { hasManagedWorktree: true },
        });
        expect(result).toEqual({
          allowed: true,
          messages: [],
          enforcement: "managed-worktree",
        });
      }),
    );

    it.effect("lets a user disable an active hook", () =>
      Effect.gen(function* () {
        const registry = yield* HookRegistry.HookRegistry;
        const projectId = ProjectId.make("hook-project-d");
        const draft = yield* registry.createDraft({
          projectId,
          name: "Toggle",
          event: "turn_end",
          script: 'return { decision: "block" };',
        });
        yield* registry.approve({
          projectId,
          hookId: draft.id,
          reviewedSha256: draft.scriptSha256,
        });
        yield* registry.setEnabled({ projectId, hookId: draft.id, enabled: false });
        const result = yield* registry.runEvent({ projectId, event: "turn_end", payload: {} });
        expect(result.allowed).toBe(true);
      }),
    );
  });
});
