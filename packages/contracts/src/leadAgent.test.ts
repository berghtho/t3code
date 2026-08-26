import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  LeadAgentCompleteTurnInput,
  LeadAgentError,
  LeadAgentStreamEvent,
  LeadAgentSubscriptionInput,
} from "./leadAgent.ts";

const decodeCompleteTurnInput = Schema.decodeUnknownSync(LeadAgentCompleteTurnInput);
const decodeSubscriptionInput = Schema.decodeUnknownSync(LeadAgentSubscriptionInput);
const decodeStreamEvent = Schema.decodeUnknownSync(LeadAgentStreamEvent);
const decodeLeadAgentError = Schema.decodeUnknownSync(LeadAgentError);

describe("Lead Agent contracts", () => {
  it("preserves protocol-valid Owner turns", () => {
    expect(decodeCompleteTurnInput({ projectId: " project-1 ", content: "  Continue.  " })).toEqual(
      {
        projectId: "project-1",
        content: "  Continue.  ",
      },
    );
    expect(() => decodeCompleteTurnInput({ projectId: "project-1", content: "   " })).toThrow();
    expect(() => decodeCompleteTurnInput({ projectId: "project-1", content: "" })).toThrow();
    expect(() =>
      decodeCompleteTurnInput({ workspaceRoot: "/client/path", content: "Continue." }),
    ).toThrow();
  });

  it("keeps Native Harness selection behind the CMD Riker boundary", () => {
    expect(
      decodeCompleteTurnInput({
        projectId: "project-1",
        content: "Use the best available Worker Session.",
        provider: "github",
        nativeHarness: "copilot",
      }),
    ).toEqual({
      projectId: "project-1",
      content: "Use the best available Worker Session.",
    });
  });

  it("requires a branded project id for Lead Agent subscriptions", () => {
    expect(decodeSubscriptionInput({ projectId: " project-1 " })).toEqual({
      projectId: "project-1",
    });
    expect(() => decodeSubscriptionInput({ projectId: "   " })).toThrow();
    expect(() => decodeSubscriptionInput({ workspaceRoot: "/client/path" })).toThrow();
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
