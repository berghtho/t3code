import { useCallback, useReducer, useRef, type FormEvent } from "react";
import {
  AlertCircleIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SendHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type LeadAgentSnapshot,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import ChatMarkdown from "../ChatMarkdown";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { leadAgentEnvironment } from "../../state/leadAgent";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { useProject, useServerConfigs } from "../../state/entities";
import { useEnvironmentSessionState } from "../../state/session";
import { SessionViewPanel } from "./SessionViewPanel";
import { useLeadConversationScroll } from "./useLeadConversationScroll";

type LeadAgentCapability = "loading" | "supported" | "unsupported";

export function canOperateLeadAgent(
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
): boolean {
  return (
    session !== null &&
    session.authenticated &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true
  );
}

export function canSubmitOwnerTurn(content: string, canOperate: boolean): boolean {
  return canOperate && content.trim().length > 0;
}

interface OwnerTurnComposerState {
  readonly draft: string;
  readonly draftRevision: number;
  readonly pending: ReadonlyArray<number>;
  readonly latest: {
    readonly id: number;
    readonly draftRevision: number;
    readonly content: string;
    readonly clearDraft: boolean;
  } | null;
  readonly submissionError: string | null;
}

export const EMPTY_OWNER_TURN_COMPOSER: OwnerTurnComposerState = {
  draft: "",
  draftRevision: 0,
  pending: [],
  latest: null,
  submissionError: null,
};

export function reduceOwnerTurnComposer(
  state: OwnerTurnComposerState,
  action:
    | { readonly type: "edit"; readonly content: string }
    | {
        readonly type: "submit";
        readonly id: number;
        readonly content: string;
        readonly clearDraft: boolean;
      }
    | { readonly type: "settle"; readonly id: number; readonly error: string | null },
): OwnerTurnComposerState {
  switch (action.type) {
    case "edit":
      return {
        ...state,
        draft: action.content,
        draftRevision: state.draftRevision + 1,
        submissionError: null,
      };
    case "submit":
      return {
        ...state,
        draft: action.clearDraft && state.draft === action.content ? "" : state.draft,
        pending: [...state.pending, action.id],
        latest: {
          id: action.id,
          draftRevision: state.draftRevision,
          content: action.content,
          clearDraft: action.clearDraft,
        },
        submissionError: null,
      };
    case "settle": {
      const latest = state.latest;
      const current = latest?.id === action.id && latest.draftRevision === state.draftRevision;
      return {
        ...state,
        draft:
          current && action.error !== null && latest.clearDraft && state.draft === ""
            ? latest.content
            : state.draft,
        pending: state.pending.filter((id) => id !== action.id),
        submissionError: current ? action.error : state.submissionError,
      };
    }
  }
}

function commandFailureMessage(failure: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Riker could not receive that turn.";
}

export function LeadAgentPage({ projectRef }: { readonly projectRef: ScopedProjectRef }) {
  const project = useProject(projectRef);
  const serverConfig = useServerConfigs().get(projectRef.environmentId);
  const capability: LeadAgentCapability =
    serverConfig === undefined
      ? "loading"
      : serverConfig.environment.capabilities.leadAgent === true
        ? "supported"
        : "unsupported";
  const query = useEnvironmentQuery(
    capability === "supported"
      ? leadAgentEnvironment.state({
          environmentId: projectRef.environmentId,
          input: { projectId: projectRef.projectId },
        })
      : null,
  );
  const completeTurn = useAtomCommand(leadAgentEnvironment.completeTurn, {
    reportFailure: false,
  });
  const environmentSession = useEnvironmentSessionState(projectRef.environmentId);
  const canOperate = environmentSession.hasError || canOperateLeadAgent(environmentSession.data);
  const permissionPending = environmentSession.data === null && environmentSession.isPending;
  const streamStopped = query.error !== null || query.data?.exit !== null;
  const canSendOwnerTurns = canOperate && !streamStopped;
  const [composer, dispatchComposer] = useReducer(
    reduceOwnerTurnComposer,
    EMPTY_OWNER_TURN_COMPOSER,
  );
  const nextRequestId = useRef(0);

  const onSubmitTurn = useCallback(
    async (content: string, clearDraft = true) => {
      if (!canSubmitOwnerTurn(content, canSendOwnerTurns)) return;
      const id = ++nextRequestId.current;
      dispatchComposer({ type: "submit", id, content, clearDraft });
      const result = await completeTurn({
        environmentId: projectRef.environmentId,
        input: { projectId: projectRef.projectId, content },
      });
      dispatchComposer({
        type: "settle",
        id,
        error: result._tag === "Success" ? null : commandFailureMessage(result),
      });
    },
    [canSendOwnerTurns, completeTurn, projectRef.environmentId, projectRef.projectId],
  );

  return (
    <LeadAgentSurface
      capability={capability}
      projectTitle={project?.title ?? "Project"}
      environmentId={projectRef.environmentId}
      state={query.data}
      streamError={query.error}
      submissionError={composer.submissionError}
      draft={composer.draft}
      submitting={composer.pending.length > 0}
      canOperate={canOperate}
      permissionPending={permissionPending}
      onDraftChange={(content) => dispatchComposer({ type: "edit", content })}
      onRetry={query.refresh}
      onSubmitTurn={onSubmitTurn}
      onInterrupt={() => onSubmitTurn("/interrupt", false)}
    />
  );
}

export function LeadAgentSurface(props: {
  readonly capability: LeadAgentCapability;
  readonly projectTitle: string;
  readonly environmentId: ScopedProjectRef["environmentId"];
  readonly state: {
    readonly snapshot: LeadAgentSnapshot | null;
    readonly transientNotice: string | null;
    readonly exit: { readonly kind: string; readonly error?: string | undefined } | null;
  } | null;
  readonly streamError: string | null;
  readonly submissionError: string | null;
  readonly draft: string;
  readonly submitting: boolean;
  readonly canOperate: boolean;
  readonly permissionPending: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onRetry: () => void;
  readonly onSubmitTurn: (content: string) => void | Promise<void>;
  readonly onInterrupt: () => void | Promise<void>;
}) {
  const snapshot = props.state?.snapshot ?? null;
  const conversationEntries =
    snapshot === null
      ? []
      : withOccurrenceKeys(
          snapshot.conversation,
          (entry) => `${snapshot.ownerSessionRevision}:${entry.source}:${entry.content}`,
        );
  const streamStopped = props.state?.exit !== null || props.streamError !== null;
  const canSendOwnerTurns = props.canOperate && !streamStopped;
  const responding = snapshot?.leadState === "responding" || props.submitting;
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followToEnd = useLeadConversationScroll(
    snapshot && props.capability === "supported"
      ? JSON.stringify([
          props.environmentId,
          snapshot.targetProjectPath,
          snapshot.ownerSessionRevision,
        ])
      : null,
    snapshot?.conversation,
    viewportRef,
    contentRef,
  );
  const submitTurn = () => {
    if (!canSubmitOwnerTurn(props.draft, canSendOwnerTurns)) return;
    followToEnd();
    void props.onSubmitTurn(props.draft);
  };
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitTurn();
  };

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border/70">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card text-muted-foreground">
              <MessageSquareIcon aria-hidden className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-sm font-semibold">CMD Riker</h1>
                {snapshot ? <LeadStateBadge state={snapshot.leadState} /> : null}
              </div>
              <p className="truncate text-xs text-muted-foreground">{props.projectTitle}</p>
            </div>
          </div>
        </WorkspacePageHeader>

        {props.capability === "unsupported" ? (
          <CenteredState
            title="Lead Agent unavailable"
            detail="This environment does not expose the CMD Riker Lead Agent bridge."
          />
        ) : props.streamError && snapshot === null ? (
          <CenteredState
            title="Could not reach Riker"
            detail={props.streamError}
            onRetry={props.onRetry}
          />
        ) : props.capability === "loading" || snapshot === null ? (
          <CenteredState
            title="Connecting to Riker"
            detail="Waiting for the project-scoped Owner Gateway."
          />
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <main className="flex min-h-0 min-w-0 flex-col">
              <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto">
                <div
                  ref={contentRef}
                  className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-7 sm:px-8"
                >
                  {props.state?.transientNotice ? (
                    <NoticeBanner content={props.state.transientNotice} />
                  ) : null}
                  {props.state?.exit || props.streamError ? (
                    <NoticeBanner
                      content={props.streamError ?? "The Owner Gateway stopped."}
                      destructive
                      onRetry={props.onRetry}
                    />
                  ) : null}
                  {snapshot.conversation.length === 0 ? (
                    <div className="py-16 text-center">
                      <p className="text-sm font-medium">
                        {snapshot.leadState === "available"
                          ? "Riker is ready."
                          : snapshot.leadState === "responding"
                            ? "Riker is responding."
                            : "Riker is starting."}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {snapshot.leadState === "available"
                          ? "Give the Lead Agent an outcome or ask for the current situation."
                          : "Waiting for the Lead Agent to become available."}
                      </p>
                    </div>
                  ) : (
                    conversationEntries.map(({ key, value: entry }) => (
                      <ConversationEntry
                        key={key}
                        source={entry.source}
                        content={entry.content}
                        cwd={snapshot.targetProjectPath}
                        environmentId={props.environmentId}
                      />
                    ))
                  )}
                </div>
              </div>

              <form
                onSubmit={handleSubmit}
                className="border-t border-border/70 bg-background/95 p-4"
              >
                <div className="mx-auto max-w-3xl">
                  <label htmlFor="lead-agent-owner-turn" className="sr-only">
                    Message CMD Riker
                  </label>
                  <div className="flex items-end gap-2">
                    <Textarea
                      id="lead-agent-owner-turn"
                      value={props.draft}
                      onChange={(event) => props.onDraftChange(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault();
                          submitTurn();
                        }
                      }}
                      placeholder="Tell Riker what outcome you need…"
                      disabled={!canSendOwnerTurns}
                      aria-invalid={props.submissionError ? true : undefined}
                      aria-describedby="lead-agent-owner-turn-help"
                      className="flex-1"
                    />
                    <Button
                      type="submit"
                      size="icon-lg"
                      disabled={!canSubmitOwnerTurn(props.draft, canSendOwnerTurns)}
                      aria-label="Send Owner turn"
                    >
                      <SendHorizontalIcon aria-hidden />
                    </Button>
                    {responding ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!canSendOwnerTurns}
                        onClick={() => void props.onInterrupt()}
                      >
                        <SquareIcon aria-hidden />
                        Interrupt
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-2 flex min-h-5 items-start justify-between gap-3 text-xs text-muted-foreground">
                    <span
                      id="lead-agent-owner-turn-help"
                      role={props.submissionError ? "alert" : undefined}
                      className={props.submissionError ? "text-destructive-foreground" : undefined}
                    >
                      {props.submissionError ??
                        (streamStopped
                          ? "Reconnect before sending another Owner turn."
                          : props.permissionPending
                            ? "Checking whether this session can send Owner turns."
                            : props.canOperate
                              ? responding
                                ? "Send to redirect Riker, or interrupt the Lead. Workers keep running."
                                : "Ctrl or Command + Enter to send"
                              : "This session can observe CMD Riker but cannot send Owner turns.")}
                    </span>
                    {snapshot.leadState === "responding" ? (
                      <span>Riker is responding</span>
                    ) : props.submitting ? (
                      <span>Waiting for Riker</span>
                    ) : null}
                  </div>
                </div>
              </form>
            </main>

            <SessionViewPanel
              key={JSON.stringify([
                props.environmentId,
                snapshot.targetProjectPath,
                snapshot.ownerSessionRevision,
              ])}
              sessionView={snapshot.sessionView}
            />
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

function ConversationEntry(props: {
  readonly source: "owner" | "lead-agent";
  readonly content: string;
  readonly cwd: string;
  readonly environmentId: ScopedProjectRef["environmentId"];
}) {
  const owner = props.source === "owner";
  return (
    <article className={owner ? "ml-auto max-w-[88%]" : "mr-auto w-full"}>
      <p className={`mb-1.5 text-xs font-medium ${owner ? "text-right" : "text-muted-foreground"}`}>
        {owner ? "Owner" : "Riker"}
      </p>
      {owner ? (
        <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-sm leading-relaxed">
          {props.content}
        </div>
      ) : (
        <div className="text-sm leading-relaxed">
          <ChatMarkdown
            text={props.content}
            cwd={props.cwd}
            environmentId={props.environmentId}
            lineBreaks
          />
        </div>
      )}
    </article>
  );
}

function LeadStateBadge({ state }: { readonly state: LeadAgentSnapshot["leadState"] }) {
  const variant = state === "available" ? "success" : state === "responding" ? "info" : "outline";
  return (
    <Badge size="sm" variant={variant}>
      {humanize(state)}
    </Badge>
  );
}

function CenteredState(props: {
  readonly title: string;
  readonly detail: string;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold">{props.title}</p>
        <p className="mt-2 text-sm text-muted-foreground">{props.detail}</p>
        {props.onRetry ? (
          <Button className="mt-4" size="sm" variant="outline" onClick={props.onRetry}>
            <RefreshCwIcon aria-hidden />
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function NoticeBanner({
  content,
  destructive = false,
  onRetry,
}: {
  readonly content: string;
  readonly destructive?: boolean;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${
        destructive
          ? "border-destructive/30 bg-destructive/6 text-destructive-foreground"
          : "border-info/30 bg-info/6 text-info-foreground"
      }`}
    >
      <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1">{content}</span>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCwIcon aria-hidden />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function humanize(value: string): string {
  return value.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase());
}

function withOccurrenceKeys<T>(
  values: ReadonlyArray<T>,
  identityOf: (value: T) => string,
): ReadonlyArray<{ readonly key: string; readonly value: T }> {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const identity = identityOf(value);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { key: `${identity}:${occurrence}`, value };
  });
}
