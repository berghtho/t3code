import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { readonly text: string }) => <p>{text}</p>,
}));

import {
  canOperateLeadAgent,
  canSubmitOwnerTurn,
  EMPTY_OWNER_TURN_COMPOSER,
  LeadAgentSurface,
  reduceOwnerTurnComposer,
} from "./LeadAgentPage";

const commonProps = {
  projectTitle: "CMD Riker",
  environmentId: EnvironmentId.make("environment-1"),
  streamError: null,
  submissionError: null,
  draft: "",
  submitting: false,
  canOperate: true,
  permissionPending: false,
  onDraftChange: () => undefined,
  onRetry: () => undefined,
  onSubmitTurn: () => undefined,
  onInterrupt: () => undefined,
} as const;

describe("LeadAgentSurface", () => {
  it("renders version-skew and loading states", () => {
    expect(
      renderToStaticMarkup(
        <LeadAgentSurface {...commonProps} capability="unsupported" state={null} />,
      ),
    ).toContain("does not expose the CMD Riker Lead Agent bridge");
    expect(
      renderToStaticMarkup(<LeadAgentSurface {...commonProps} capability="loading" state={null} />),
    ).toContain("Waiting for the project-scoped Owner Gateway");
  });

  it("keeps conversation dominant while showing the supplied Session View", () => {
    const markup = renderToStaticMarkup(
      <LeadAgentSurface
        {...commonProps}
        capability="supported"
        state={{
          transientNotice: "A decision is required.",
          exit: null,
          snapshot: {
            targetProjectPath: "C:\\repos\\cmd-riker",
            ownerSessionRevision: 3,
            leadState: "available",
            conversation: [
              { source: "owner", content: "Keep the fork current." },
              { source: "lead-agent", content: "I’ll preserve the Riker boundary." },
            ],
            sessionView: {
              leadAvailability: "available",
              activeWorkerCount: 1,
              workers: [
                {
                  number: 1,
                  label: "Review upstream changes",
                  status: "running",
                  cancellable: true,
                  workItemNumber: 4,
                },
              ],
              items: [
                {
                  number: 4,
                  outcome: "Keep the downstream fork current",
                  status: "active",
                  needsOwner: true,
                },
              ],
              notices: ["Owner confirmation is needed."],
            },
          },
        }}
      />,
    );

    expect(markup).toContain("Keep the fork current.");
    expect(markup).toContain("I’ll preserve the Riker boundary.");
    expect(markup).toContain("Session View");
    expect(markup).toContain("Keep the downstream fork current");
    expect(markup).toContain("A decision is required.");
  });

  it("accepts non-blank Owner turns when the session can send", () => {
    expect(canSubmitOwnerTurn("  ", true)).toBe(false);
    expect(canSubmitOwnerTurn("Continue.  ", true)).toBe(true);
    expect(canSubmitOwnerTurn("Continue.", false)).toBe(false);
    expect(canSubmitOwnerTurn("/interrupt", false)).toBe(false);
  });

  it("keeps read-only sessions observational", () => {
    const readOnlySession = {
      authenticated: true,
      scopes: [AuthOrchestrationReadScope],
    } satisfies Pick<AuthSessionState, "authenticated" | "scopes">;
    const operateSession = {
      ...readOnlySession,
      scopes: [AuthOrchestrationOperateScope],
    } satisfies Pick<AuthSessionState, "authenticated" | "scopes">;

    expect(canOperateLeadAgent(readOnlySession)).toBe(false);
    expect(canOperateLeadAgent(operateSession)).toBe(true);
    expect(canOperateLeadAgent(null)).toBe(false);

    const markup = renderToStaticMarkup(
      <LeadAgentSurface
        {...commonProps}
        capability="supported"
        canOperate={false}
        state={{
          transientNotice: null,
          exit: null,
          snapshot: {
            targetProjectPath: "C:\\repos\\cmd-riker",
            ownerSessionRevision: 1,
            leadState: "available",
            conversation: [],
          },
        }}
      />,
    );
    expect(markup).toContain("can observe CMD Riker but cannot send Owner turns");
    expect(markup).toContain("disabled");
  });

  it("fails closed while session permissions load", () => {
    const markup = renderToStaticMarkup(
      <LeadAgentSurface
        {...commonProps}
        capability="supported"
        canOperate={false}
        permissionPending
        state={{
          transientNotice: null,
          exit: null,
          snapshot: {
            targetProjectPath: "C:\\repos\\cmd-riker",
            ownerSessionRevision: 1,
            leadState: "available",
            conversation: [],
          },
        }}
      />,
    );
    expect(markup).toContain("Checking whether this session can send Owner turns");
    expect(markup).toContain("disabled");
  });

  it("offers reconnect after a terminal stream state and reports starting truthfully", () => {
    const markup = renderToStaticMarkup(
      <LeadAgentSurface
        {...commonProps}
        capability="supported"
        state={{
          transientNotice: null,
          exit: { kind: "failed", error: "gateway stopped" },
          snapshot: {
            targetProjectPath: "C:\\repos\\cmd-riker",
            ownerSessionRevision: 1,
            leadState: "starting",
            conversation: [],
          },
        }}
      />,
    );
    expect(markup).toContain("The Owner Gateway stopped.");
    expect(markup).toContain("Retry");
    expect(markup).toContain("Reconnect before sending another Owner turn.");
    expect(markup).toContain("Riker is starting.");
    expect(markup).not.toContain("Riker is ready.");
  });
});

function composer() {
  let state = EMPTY_OWNER_TURN_COMPOSER;
  let nextId = 0;
  return {
    get state() {
      return state;
    },
    edit(content: string) {
      state = reduceOwnerTurnComposer(state, { type: "edit", content });
    },
    send(content = state.draft, clearDraft = true) {
      const id = ++nextId;
      state = reduceOwnerTurnComposer(state, { type: "submit", id, content, clearDraft });
      return id;
    },
    settle(id: number, error: string | null = null) {
      state = reduceOwnerTurnComposer(state, { type: "settle", id, error });
    },
  };
}

describe("Owner turn composer", () => {
  it("clears a sent draft immediately and accepts a follow-up before the first reply", () => {
    const owner = composer();
    owner.edit("Start the review.");
    const first = owner.send();
    expect(owner.state.draft).toBe("");
    owner.edit("Focus on authentication.");
    expect(canSubmitOwnerTurn(owner.state.draft, true)).toBe(true);
    const second = owner.send();
    expect(owner.state.pending).toHaveLength(2);

    owner.edit("A third draft");
    owner.settle(first);
    expect(owner.state.draft).toBe("A third draft");
    expect(owner.state.pending).toEqual([second]);
    owner.settle(second);
    expect(owner.state.draft).toBe("A third draft");
    expect(owner.state.pending).toEqual([]);
  });

  it("ignores an old failure after a newer request succeeds", () => {
    const owner = composer();
    owner.edit("Review everything.");
    const first = owner.send();
    owner.edit("Review just authentication.");
    const second = owner.send();
    owner.settle(second);
    owner.settle(first, "The first turn was interrupted.");
    expect(owner.state.submissionError).toBeNull();
    expect(owner.state.pending).toEqual([]);
  });

  it("retains the latest failure when an earlier request completes later", () => {
    const owner = composer();
    owner.edit("First request");
    const first = owner.send();
    owner.edit("Second request");
    const second = owner.send();
    owner.settle(second, "Connection lost.");
    owner.settle(first);
    expect(owner.state.submissionError).toBe("Connection lost.");
    expect(owner.state.draft).toBe("Second request");
  });

  it("does not attach an earlier failure to a newly edited draft", () => {
    const owner = composer();
    owner.edit("First request");
    const first = owner.send();
    owner.edit("A different request");
    owner.settle(first, "The earlier request failed.");
    expect(owner.state.draft).toBe("A different request");
    expect(owner.state.submissionError).toBeNull();
  });

  it("does not resurrect a failed draft after the Owner clears newer text", () => {
    const owner = composer();
    owner.edit("First request");
    const first = owner.send();
    owner.edit("A different request");
    owner.edit("");
    owner.settle(first, "The earlier request failed.");
    expect(owner.state.draft).toBe("");
    expect(owner.state.submissionError).toBeNull();
  });

  it("interrupts without consuming a draft or losing pending reply accounting", () => {
    const owner = composer();
    owner.edit("Review everything.");
    const first = owner.send();
    owner.edit("A follow-up to send later");
    const interrupt = owner.send("/interrupt", false);
    owner.settle(interrupt);
    expect(owner.state.draft).toBe("A follow-up to send later");
    expect(owner.state.pending).toEqual([first]);
    owner.settle(first, "Interrupted.");
    expect(owner.state.submissionError).toBeNull();
    expect(owner.state.pending).toEqual([]);
  });
});
