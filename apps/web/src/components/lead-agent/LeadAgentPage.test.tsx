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

import { canOperateLeadAgent, canSubmitOwnerTurn, LeadAgentSurface } from "./LeadAgentPage";

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
    expect(markup).toContain("Review upstream changes");
    expect(markup).toContain("Keep the downstream fork current");
    expect(markup).toContain("A decision is required.");
  });

  it("submits only non-blank Owner turns while idle", () => {
    expect(canSubmitOwnerTurn("  ", false, true)).toBe(false);
    expect(canSubmitOwnerTurn("Continue.  ", false, true)).toBe(true);
    expect(canSubmitOwnerTurn("Continue.", true, true)).toBe(false);
    expect(canSubmitOwnerTurn("Continue.", false, false)).toBe(false);
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
