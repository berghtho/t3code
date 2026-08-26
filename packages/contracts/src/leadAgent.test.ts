import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { LeadAgentCompleteTurnInput, LeadAgentError, LeadAgentStreamEvent } from "./leadAgent.ts";

const decodeCompleteTurnInput = Schema.decodeUnknownSync(LeadAgentCompleteTurnInput);
const decodeStreamEvent = Schema.decodeUnknownSync(LeadAgentStreamEvent);
const decodeLeadAgentError = Schema.decodeUnknownSync(LeadAgentError);

describe("Lead Agent contracts", () => {
  it("preserves protocol-valid Owner turns", () => {
    expect(decodeCompleteTurnInput({ content: "  Continue.  " })).toEqual({
      content: "  Continue.  ",
    });
    expect(() => decodeCompleteTurnInput({ content: "   " })).toThrow();
    expect(() => decodeCompleteTurnInput({ content: "" })).toThrow();
  });

  it("decodes snapshot stream events and typed failures", () => {
    const event = decodeStreamEvent({
      version: 1,
      type: "snapshot",
      snapshot: {
        targetProjectPath: "C:\\work\\target",
        ownerSessionRevision: 2,
        leadState: "available",
        conversation: [{ source: "lead-agent", content: "Standing by." }],
        sessionView: {
          leadAvailability: "available",
          activeWorkerCount: 1,
          workers: [
            {
              number: 1,
              label: "Implement the server seam",
              status: "running",
              cancellable: true,
              workItemNumber: 2,
            },
          ],
          items: [
            {
              number: 2,
              outcome: "Expose the Lead Agent",
              status: "active",
              needsOwner: false,
            },
          ],
          notices: [],
        },
      },
    });
    const error = decodeLeadAgentError({
      _tag: "LeadAgentError",
      reason: "protocol-failed",
      message: "Invalid gateway record.",
    });

    expect(event.type).toBe("snapshot");
    expect(error).toBeInstanceOf(LeadAgentError);
    expect(error.reason).toBe("protocol-failed");
  });
});
