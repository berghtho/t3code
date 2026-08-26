import { LeadAgentError, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const hideProjectResolutionFailure = <A, E>(
  projectId: ProjectId,
  stage: "projection" | "normalization" | "canonicalization",
  effect: Effect.Effect<A, E>,
) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Lead Agent project path resolution failed.", {
        cause,
        projectId,
        stage,
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new LeadAgentError({
              reason: "project-path-unresolved",
              message: "The requested Lead Agent project workspace could not be resolved.",
            }),
          ),
        ),
      ),
    ),
  );

export const resolveLeadAgentProjectPath = Effect.fn(
  "LeadAgentProjectResolver.resolveLeadAgentProjectPath",
)(function* (projectId: ProjectId) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const fileSystem = yield* FileSystem.FileSystem;
  const project = yield* hideProjectResolutionFailure(
    projectId,
    "projection",
    projectionSnapshotQuery.getProjectShellById(projectId),
  );
  if (Option.isNone(project)) {
    return yield* new LeadAgentError({
      reason: "project-not-found",
      message: "The requested Lead Agent project is unavailable.",
    });
  }

  const normalizedWorkspaceRoot = yield* hideProjectResolutionFailure(
    projectId,
    "normalization",
    workspacePaths.normalizeWorkspaceRoot(project.value.workspaceRoot),
  );
  return yield* hideProjectResolutionFailure(
    projectId,
    "canonicalization",
    fileSystem.realPath(normalizedWorkspaceRoot),
  );
});
