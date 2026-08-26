import { LeadAgentError, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const projectNotFound = () =>
  new LeadAgentError({
    reason: "project-not-found",
    message: "The requested Lead Agent project is unavailable.",
  });

const projectPathUnresolved = () =>
  new LeadAgentError({
    reason: "project-path-unresolved",
    message: "The requested Lead Agent project workspace could not be resolved.",
  });

const hideProjectResolutionFailure = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.mapError(projectPathUnresolved),
    Effect.catchDefect(() => Effect.fail(projectPathUnresolved())),
  );

export const resolveLeadAgentProjectPath = Effect.fn(
  "LeadAgentProjectResolver.resolveLeadAgentProjectPath",
)(function* (projectId: ProjectId) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const fileSystem = yield* FileSystem.FileSystem;
  const project = yield* hideProjectResolutionFailure(
    projectionSnapshotQuery.getProjectShellById(projectId),
  );
  if (Option.isNone(project)) return yield* projectNotFound();

  const normalizedWorkspaceRoot = yield* hideProjectResolutionFailure(
    workspacePaths.normalizeWorkspaceRoot(project.value.workspaceRoot),
  );
  return yield* hideProjectResolutionFailure(fileSystem.realPath(normalizedWorkspaceRoot));
});
