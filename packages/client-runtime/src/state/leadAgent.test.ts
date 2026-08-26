import { describe, expect, it } from "vite-plus/test";

import {
  applyLeadAgentStreamEvent,
  EMPTY_LEAD_AGENT_ENVIRONMENT_STATE,
  type LeadAgentEnvironmentState,
} from "./leadAgent.ts";

const snapshot = {
  targetProjectPath: "C:\\work\\riker",
  ownerSessionRevision: 1,
  leadState: "available" as const,
  conversation: [{ source: "lead-agent" as const, content: "Standing by." }],
  sessionView: {
    leadAvailability: "available" as const,
    activeWorkerCount: 0,
    workers: [],
    items: [],
    notices: [],
  },
};

describe("Lead Agent environment state", () => {
  it("replaces state from a fresh snapshot", () => {
    expect(
      applyLeadAgentStreamEvent(EMPTY_LEAD_AGENT_ENVIRONMENT_STATE, {
        version: 1,
        type: "snapshot",
        snapshot,
      }),
    ).toEqual({ snapshot, transientNotice: null, exit: null });
  });

  it("projects conversation, Session View, and Lead state events", () => {
    const initial: LeadAgentEnvironmentState = {
      snapshot,
      transientNotice: null,
      exit: null,
    };
    const conversation = [{ source: "owner" as const, content: "Continue." }];
    const withConversation = applyLeadAgentStreamEvent(initial, {
      version: 1,
      type: "event",
      event: {
        type: "conversation",
        conversation,
        targetProjectPath: "C:\\work\\next",
        ownerSessionRevision: 2,
        replaced: true,
      },
    });
    const withSessionView = applyLeadAgentStreamEvent(withConversation, {
      version: 1,
      type: "event",
      event: {
        type: "session-view",
        sessionView: { ...snapshot.sessionView, activeWorkerCount: 1 },
      },
    });
    const responding = applyLeadAgentStreamEvent(withSessionView, {
      version: 1,
      type: "event",
      event: { type: "lead-state", state: "responding" },
    });

    expect(responding.snapshot).toMatchObject({
      targetProjectPath: "C:\\work\\next",
      ownerSessionRevision: 2,
      leadState: "responding",
      conversation,
      sessionView: { activeWorkerCount: 1 },
    });
  });

  it("retains transient notices and terminal exits outside the snapshot", () => {
    const noticed = applyLeadAgentStreamEvent(
      { snapshot, transientNotice: null, exit: null },
      {
        version: 1,
        type: "event",
        event: { type: "notice", content: "Owner input is required." },
      },
    );
    const exited = applyLeadAgentStreamEvent(noticed, {
      version: 1,
      type: "event",
      event: {
        type: "exit",
        exit: { kind: "unexpected-child-exit", code: 1, signal: null },
      },
    });

    expect(exited.transientNotice).toBe("Owner input is required.");
    expect(exited.exit?.kind).toBe("unexpected-child-exit");
  });
});
