import { createFileRoute } from "@tanstack/react-router";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";

import { LeadAgentPage } from "../components/lead-agent/LeadAgentPage";
import { resolveLeadAgentRouteRef } from "../leadAgentRoutes";

function LeadAgentRouteView() {
  const projectRef = Route.useParams({ select: resolveLeadAgentRouteRef });
  return projectRef === null ? null : (
    <LeadAgentPage key={scopedProjectKey(projectRef)} projectRef={projectRef} />
  );
}

export const Route = createFileRoute("/_chat/lead-agent/$environmentId/$projectId")({
  component: LeadAgentRouteView,
});
