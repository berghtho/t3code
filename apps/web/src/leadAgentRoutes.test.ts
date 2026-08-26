import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildLeadAgentRouteParams, resolveLeadAgentRouteRef } from "./leadAgentRoutes";

describe("Lead Agent routes", () => {
  it("builds canonical project-scoped route params", () => {
    expect(
      buildLeadAgentRouteParams({
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
      }),
    ).toEqual({ environmentId: "environment-1", projectId: "project-1" });
  });

  it("resolves only complete project-scoped params", () => {
    expect(
      resolveLeadAgentRouteRef({ environmentId: "environment-1", projectId: "project-1" }),
    ).toEqual({ environmentId: "environment-1", projectId: "project-1" });
    expect(resolveLeadAgentRouteRef({ environmentId: "environment-1" })).toBeNull();
  });
});
