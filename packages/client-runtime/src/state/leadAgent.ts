import {
  type LeadAgentEvent,
  type LeadAgentSnapshot,
  type LeadAgentStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

type LeadAgentExit = Extract<LeadAgentEvent, { readonly type: "exit" }>["exit"];

export interface LeadAgentEnvironmentState {
  readonly snapshot: LeadAgentSnapshot | null;
  readonly transientNotice: string | null;
  readonly exit: LeadAgentExit | null;
}

export const EMPTY_LEAD_AGENT_ENVIRONMENT_STATE: LeadAgentEnvironmentState = {
  snapshot: null,
  transientNotice: null,
  exit: null,
};

export function applyLeadAgentStreamEvent(
  state: LeadAgentEnvironmentState,
  streamEvent: LeadAgentStreamEvent,
): LeadAgentEnvironmentState {
  if (streamEvent.type === "snapshot") {
    return {
      snapshot: streamEvent.snapshot,
      transientNotice: null,
      exit: null,
    };
  }

  const event = streamEvent.event;
  if (event.type === "notice") {
    return { ...state, transientNotice: event.content };
  }
  if (event.type === "exit") {
    return { ...state, exit: event.exit };
  }
  if (state.snapshot === null) {
    return state;
  }

  switch (event.type) {
    case "conversation":
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          conversation: event.conversation,
          targetProjectPath: event.targetProjectPath,
          ownerSessionRevision: event.ownerSessionRevision,
        },
      };
    case "session-view":
      return {
        ...state,
        snapshot: { ...state.snapshot, sessionView: event.sessionView },
      };
    case "lead-state":
      return {
        ...state,
        snapshot: { ...state.snapshot, leadState: event.state },
      };
  }
}

export function createLeadAgentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const turnScheduler = createAtomCommandScheduler();
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:lead-agent:state",
      tag: WS_METHODS.subscribeLeadAgent,
      transform: (stream) =>
        stream.pipe(Stream.scan(EMPTY_LEAD_AGENT_ENVIRONMENT_STATE, applyLeadAgentStreamEvent)),
    }),
    completeTurn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:lead-agent:complete-turn",
      tag: WS_METHODS.leadAgentCompleteTurn,
      scheduler: turnScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
      },
    }),
  };
}
