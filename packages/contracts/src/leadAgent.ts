import * as Schema from "effect/Schema";

export const LeadAgentConversationEntry = Schema.Struct({
  source: Schema.Literals(["owner", "lead-agent"]),
  content: Schema.String,
});
export type LeadAgentConversationEntry = typeof LeadAgentConversationEntry.Type;

export const LeadAgentSessionView = Schema.Struct({
  leadAvailability: Schema.Literals(["available", "responding"]),
  activeWorkerCount: Schema.Number,
  workers: Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      label: Schema.String,
      status: Schema.Literals([
        "starting",
        "running",
        "waiting-question",
        "cancellation-requested",
        "reconciling",
        "completed",
        "blocked",
        "failed",
        "cancelled",
      ]),
      cancellable: Schema.Boolean,
      workItemNumber: Schema.optional(Schema.Number),
      startedAt: Schema.optional(Schema.String),
    }),
  ),
  items: Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      outcome: Schema.String,
      status: Schema.String,
      needsOwner: Schema.Boolean,
      detail: Schema.optional(Schema.String),
      since: Schema.optional(Schema.String),
    }),
  ),
  notices: Schema.Array(Schema.String),
  lead: Schema.optional(
    Schema.Struct({
      provider: Schema.String,
      model: Schema.String,
      thinkingLevel: Schema.optional(
        Schema.Literals(["minimal", "low", "medium", "high", "xhigh"]),
      ),
      contextTokens: Schema.Number,
      contextWindow: Schema.NullOr(Schema.Number),
    }),
  ),
  standingOrders: Schema.optional(
    Schema.Array(
      Schema.Struct({
        number: Schema.Number,
        title: Schema.String,
        status: Schema.Literals(["active", "expired", "revoked"]),
        instruction: Schema.String,
        effectClasses: Schema.Array(Schema.String),
        targets: Schema.Array(Schema.String),
        allowIrreversibleEffects: Schema.Boolean,
        allowExternallyBindingEffects: Schema.Boolean,
        maximumIncrementalSpendUsd: Schema.Number,
        validUntil: Schema.String,
        revocationReason: Schema.optional(Schema.String),
      }),
    ),
  ),
  sessions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        number: Schema.Number,
        name: Schema.String,
        current: Schema.Boolean,
        lastActiveAt: Schema.String,
        state: Schema.Literals(["active", "archived"]),
        project: Schema.optional(Schema.String),
      }),
    ),
  ),
  projects: Schema.optional(
    Schema.Array(
      Schema.Struct({
        number: Schema.Number,
        name: Schema.String,
        path: Schema.String,
        sessionCount: Schema.Number,
      }),
    ),
  ),
});
export type LeadAgentSessionView = typeof LeadAgentSessionView.Type;

export const LeadAgentSnapshot = Schema.Struct({
  targetProjectPath: Schema.String,
  ownerSessionRevision: Schema.Number,
  leadState: Schema.Literals(["starting", "available", "responding"]),
  conversation: Schema.Array(LeadAgentConversationEntry),
  sessionView: Schema.optional(LeadAgentSessionView),
});
export type LeadAgentSnapshot = typeof LeadAgentSnapshot.Type;

export const LeadAgentEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("conversation"),
    conversation: Schema.Array(LeadAgentConversationEntry),
    targetProjectPath: Schema.String,
    ownerSessionRevision: Schema.Number,
    replaced: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("session-view"),
    sessionView: LeadAgentSessionView,
  }),
  Schema.Struct({
    type: Schema.Literal("lead-state"),
    state: Schema.Literals(["available", "responding"]),
  }),
  Schema.Struct({
    type: Schema.Literal("notice"),
    content: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    exit: Schema.Struct({
      kind: Schema.Literals(["explicit-stop", "graceful-shutdown", "unexpected-child-exit"]),
      code: Schema.NullOr(Schema.Number),
      signal: Schema.NullOr(Schema.String),
      error: Schema.optional(Schema.String),
    }),
  }),
]);
export type LeadAgentEvent = typeof LeadAgentEvent.Type;

export const LeadAgentStreamEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("snapshot"),
    snapshot: LeadAgentSnapshot,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("event"),
    event: LeadAgentEvent,
  }),
]);
export type LeadAgentStreamEvent = typeof LeadAgentStreamEvent.Type;

export const LeadAgentCompleteTurnInput = Schema.Struct({
  content: Schema.String.check(
    Schema.makeFilter((content) => content.trim().length > 0 || "Owner turn cannot be blank"),
  ),
});
export type LeadAgentCompleteTurnInput = typeof LeadAgentCompleteTurnInput.Type;

export const LeadAgentResponse = Schema.Struct({
  source: Schema.Literals(["Lead Agent", "Session View"]),
  content: Schema.String,
});
export type LeadAgentResponse = typeof LeadAgentResponse.Type;

export const LeadAgentFailureReason = Schema.Literals([
  "spawn-failed",
  "handshake-timeout",
  "protocol-failed",
  "process-exited",
  "stream-closed",
  "turn-failed",
  "write-failed",
]);
export type LeadAgentFailureReason = typeof LeadAgentFailureReason.Type;

export class LeadAgentError extends Schema.TaggedErrorClass<LeadAgentError>()("LeadAgentError", {
  reason: LeadAgentFailureReason,
  message: Schema.String,
}) {}
