import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { resolveLeadAgentProjectPath } from "./LeadAgentProjectResolver.ts";

const projectId = ProjectId.make("project-1");

const projectShell = (workspaceRoot: string) => ({
  id: projectId,
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const resolveWith = (
  getProjectShellById: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]["getProjectShellById"],
) =>
  resolveLeadAgentProjectPath(projectId).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({ getProjectShellById }),
      ),
    ),
  );

describe("resolveLeadAgentProjectPath", () => {
  it.effect("normalizes and canonicalizes an active projected project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-lead-agent-project-",
        });
        const canonicalWorkspaceRoot = yield* fileSystem.realPath(workspaceRoot);

        expect(
          yield* resolveWith(() => Effect.succeed(Option.some(projectShell(`${workspaceRoot}/.`)))),
        ).toBe(canonicalWorkspaceRoot);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an unknown or deleted project without consulting client paths", () =>
    Effect.gen(function* () {
      const error = yield* resolveWith(() => Effect.succeed(Option.none())).pipe(Effect.flip);

      expect(error).toMatchObject({
        reason: "project-not-found",
        message: "The requested Lead Agent project is unavailable.",
      });
    }),
  );

  it.effect("hides projection defects and unresolved workspace details", () =>
    Effect.gen(function* () {
      const defectError = yield* resolveWith(() => Effect.die("private projection defect")).pipe(
        Effect.flip,
      );
      const missingPathError = yield* resolveWith(() =>
        Effect.succeed(Option.some(projectShell("/definitely/missing/lead-agent-project"))),
      ).pipe(Effect.flip);

      expect(defectError).toMatchObject({
        reason: "project-path-unresolved",
        message: "The requested Lead Agent project workspace could not be resolved.",
      });
      expect(missingPathError).toEqual(defectError);
    }),
  );
});
