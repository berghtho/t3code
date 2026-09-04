import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type LeadAgentCompleteTurnInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

import {
  applyLeadAgentStreamEvent,
  createLeadAgentEnvironmentAtoms,
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

it.effect(
  "sends follow-ups and interrupts before a pending turn completes, with correlated replies",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const received = yield* Queue.unbounded<string>();
        const finishFirst = Latch.makeUnsafe();
        const finishFollowUp = Latch.makeUnsafe();
        const target = new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("environment-1"),
          label: "Test environment",
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
        });
        const projectId = ProjectId.make("project-1");
        const client = {
          [WS_METHODS.leadAgentCompleteTurn]: (input: LeadAgentCompleteTurnInput) =>
            Effect.gen(function* () {
              expect(input.projectId).toBe(projectId);
              yield* Queue.offer(received, input.content);
              if (input.content === "First turn") yield* finishFirst.await;
              if (input.content === "Follow-up") yield* finishFollowUp.await;
              return { source: "Session View" as const, content: input.content };
            }),
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client,
          initialConfig: Effect.never,
          subscribeServerConfig: (input) => client.subscribeServerConfig(input),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const environmentRegistry = EnvironmentRegistry.of({
          run: (_environmentId, effect) => {
            expect(_environmentId).toBe(target.environmentId);
            return Effect.provideService(effect, EnvironmentSupervisor, supervisor);
          },
        } as EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry));
        const atoms = createLeadAgentEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const send = (content: string) =>
          Effect.promise(() =>
            atoms.completeTurn.run(registry, {
              environmentId: target.environmentId,
              input: { projectId, content },
            }),
          );

        const first = yield* send("First turn").pipe(Effect.forkChild);
        expect(yield* Queue.take(received)).toBe("First turn");
        const followUp = yield* send("Follow-up").pipe(Effect.forkChild);
        expect(yield* Queue.take(received)).toBe("Follow-up");
        const interrupt = yield* send("/interrupt").pipe(Effect.forkChild);
        expect(yield* Queue.take(received)).toBe("/interrupt");
        expect(yield* Fiber.join(interrupt)).toMatchObject({
          _tag: "Success",
          value: { content: "/interrupt" },
        });
        finishFollowUp.openUnsafe();
        expect(yield* Fiber.join(followUp)).toMatchObject({
          _tag: "Success",
          value: { content: "Follow-up" },
        });
        finishFirst.openUnsafe();
        expect(yield* Fiber.join(first)).toMatchObject({
          _tag: "Success",
          value: { content: "First turn" },
        });
      }),
    ),
);
