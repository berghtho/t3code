import { createLeadAgentEnvironmentAtoms } from "@t3tools/client-runtime/state/lead-agent";

import { connectionAtomRuntime } from "../connection/runtime";

export const leadAgentEnvironment = createLeadAgentEnvironmentAtoms(connectionAtomRuntime);
