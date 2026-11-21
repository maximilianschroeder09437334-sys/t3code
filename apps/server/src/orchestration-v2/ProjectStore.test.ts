import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );

    it.effect(
      "resolves hook scope for exact project roots and linked worktrees, rejecting ambiguity",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectStore.ProjectStoreV2;
          const sql = yield* SqlClient.SqlClient;
          const at = "2026-03-24T00:00:00.000Z";
          const projectA = ProjectId.make("project:hook-scope-a");
          const projectB = ProjectId.make("project:hook-scope-b");
          for (const [id, root] of [
            [projectA, "/projects/a"],
            [projectB, "/projects/b"],
          ] as const) {
            yield* projects.apply({
              sequence: 1,
              eventId: EventId.make(`event:${id}`),
              aggregateKind: "project",
              aggregateId: id,
              occurredAt: at,
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              type: "project.created",
              payload: {
                projectId: id,
                title: id,
                workspaceRoot: root,
                defaultModelSelection: null,
                scripts: [],
                createdAt: at,
                updatedAt: at,
              },
            });
          }
          const addThread = (
            id: string,
            projectId: ProjectId,
            path: string,
            deletedAt: string | null = null,
          ) => sql`
          INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
             interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
          VALUES (${id}, ${projectId}, 'test', 'codex', 'codex', 'auto', 'default', NULL,
            ${at}, ${at}, NULL, ${deletedAt}, ${JSON.stringify({ worktreePath: path })})`;
          yield* addThread("thread:hook-a1", projectA, "/worktrees/a");
          yield* addThread("thread:hook-a2", projectA, "/worktrees/a");
          yield* addThread("thread:hook-deleted", projectB, "/worktrees/a", at);
          assert.equal(
            Option.getOrNull(yield* projects.findActiveForHookWorkspace("/projects/a"))?.projectId,
            projectA,
          );
          assert.equal(
            Option.getOrNull(yield* projects.findActiveForHookWorkspace("/worktrees/a"))?.projectId,
            projectA,
          );
          assert.isTrue(Option.isNone(yield* projects.findActiveForHookWorkspace("/unrelated")));
          yield* addThread("thread:hook-conflict", projectB, "/worktrees/a");
          const conflict = yield* projects
            .findActiveForHookWorkspace("/worktrees/a")
            .pipe(Effect.flip);
          assert.equal(conflict.operation, "findActiveForHookWorkspace");
          assert.include(conflict.message, "Multiple projects match this workspace");
        }),
    );
    it.effect("keeps pin and archive times across later updates", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-organized");
        const at = "2026-03-24T00:00:00.000Z";
        const event = { aggregateKind: "project", aggregateId: projectId, occurredAt: at } as const;
        const meta = { commandId: null, causationEventId: null, correlationId: null, metadata: {} };
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 1,
          eventId: EventId.make("event-organized-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "Organized",
            workspaceRoot: "/tmp/project-organized",
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
          },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 2,
          eventId: EventId.make("event-organized-pinned"),
          type: "project.meta-updated",
          payload: { projectId, pinnedAt: at, archivedAt: at, updatedAt: at },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 3,
          eventId: EventId.make("event-organized-renamed"),
          type: "project.meta-updated",
          payload: { projectId, title: "Renamed", updatedAt: at },
        });
        const project = Option.getOrNull(yield* projects.get(projectId));
        assert.strictEqual(project?.pinnedAt, at);
        assert.strictEqual(project?.archivedAt, at);
      }),
    );
  },
);
