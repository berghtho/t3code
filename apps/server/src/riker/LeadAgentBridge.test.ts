import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { make } from "./LeadAgentBridge.ts";
import {
  RikerOwnerGateway,
  RikerOwnerGatewayError,
  type OwnerGatewayEvent,
  type RikerOwnerGatewayConnection,
} from "./RikerOwnerGateway.ts";

const targetProjectPath = "C:\\work\\target";
const snapshot = {
  targetProjectPath,
  ownerSessionRevision: 1,
  leadState: "available" as const,
  conversation: [],
};

describe("LeadAgentBridge", () => {
  it.effect("owns one gateway connection per project and projects it for every subscriber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OwnerGatewayEvent>();
        const connectCount = yield* Ref.make(0);
        const gateway = RikerOwnerGateway.of({
          connect: () =>
            Ref.update(connectCount, (count) => count + 1).pipe(
              Effect.as({
                childPid: 77,
                snapshot,
                events: Stream.fromQueue(events),
                completeTurn: () =>
                  Effect.succeed({
                    source: "Lead Agent" as const,
                    content: "Delegated and monitoring it.",
                  }),
              }),
            ),
        });
        const bridge = yield* make().pipe(Effect.provideService(RikerOwnerGateway, gateway));
        const firstStream = yield* bridge.subscribe(targetProjectPath);
        const firstTwo = yield* firstStream.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );

        yield* Queue.offer(events, { type: "lead-state", state: "responding" });
        const firstEvents = Array.from(yield* Fiber.join(firstTwo));
        const secondStream = yield* bridge.subscribe(targetProjectPath);
        const secondSnapshot = yield* secondStream.pipe(Stream.runHead);
        const response = yield* bridge.completeTurn(targetProjectPath, "Continue.");

        expect(firstEvents.map((event) => event.type)).toEqual(["snapshot", "event"]);
        expect(firstEvents[1]).toMatchObject({
          type: "event",
          event: { type: "lead-state", state: "responding" },
        });
        expect(secondSnapshot).toMatchObject({
          _tag: "Some",
          value: { type: "snapshot", snapshot: { leadState: "responding" } },
        });
        expect(response.content).toBe("Delegated and monitoring it.");
        expect(yield* Ref.get(connectCount)).toBe(1);
      }),
    ),
  );

  it.effect("isolates connections and projections for different canonical project paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectA = "C:\\work\\project-a";
        const projectB = "C:\\work\\project-b";
        const eventQueues = new Map<string, Queue.Queue<OwnerGatewayEvent>>();
        const connectedPaths = yield* Ref.make<ReadonlyArray<string>>([]);
        const gateway = RikerOwnerGateway.of({
          connect: (canonicalWorkspaceRoot) =>
            Effect.gen(function* () {
              const events = yield* Queue.unbounded<OwnerGatewayEvent>();
              eventQueues.set(canonicalWorkspaceRoot, events);
              yield* Ref.update(connectedPaths, (paths) => [...paths, canonicalWorkspaceRoot]);
              return {
                childPid: eventQueues.size,
                snapshot: { ...snapshot, targetProjectPath: canonicalWorkspaceRoot },
                events: Stream.fromQueue(events),
                completeTurn: () =>
                  Effect.succeed({
                    source: "Lead Agent" as const,
                    content: canonicalWorkspaceRoot,
                  }),
              };
            }),
        });
        const bridge = yield* make().pipe(Effect.provideService(RikerOwnerGateway, gateway));
        const projectAStream = yield* bridge.subscribe(projectA);
        const projectAEvents = yield* projectAStream.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const projectBSnapshot = yield* (yield* bridge.subscribe(projectB)).pipe(Stream.runHead);

        yield* Queue.offer(eventQueues.get(projectA)!, {
          type: "lead-state",
          state: "responding",
        });
        yield* Fiber.join(projectAEvents);
        const latestProjectASnapshot = yield* (yield* bridge.subscribe(projectA)).pipe(
          Stream.runHead,
        );
        const response = yield* bridge.completeTurn(projectB, "Continue project B.");

        expect(yield* Ref.get(connectedPaths)).toEqual([projectA, projectB]);
        expect(latestProjectASnapshot).toMatchObject({
          _tag: "Some",
          value: {
            type: "snapshot",
            snapshot: { targetProjectPath: projectA, leadState: "responding" },
          },
        });
        expect(projectBSnapshot).toMatchObject({
          _tag: "Some",
          value: {
            type: "snapshot",
            snapshot: { targetProjectPath: projectB, leadState: "available" },
          },
        });
        expect(response.content).toBe(projectB);
      }),
    ),
  );

  it.effect("fans out terminal failure and reconnects on the next request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const disconnected = yield* Deferred.make<never, RikerOwnerGatewayError>();
        const connectCount = yield* Ref.make(0);
        const gateway = RikerOwnerGateway.of({
          connect: () =>
            Ref.updateAndGet(connectCount, (count) => count + 1).pipe(
              Effect.map(
                (attempt): RikerOwnerGatewayConnection => ({
                  childPid: attempt,
                  snapshot,
                  events:
                    attempt === 1 ? Stream.fromEffect(Deferred.await(disconnected)) : Stream.never,
                  completeTurn: () =>
                    Effect.succeed({ source: "Lead Agent", content: "Reconnected." }),
                }),
              ),
            ),
        });
        const bridge = yield* make().pipe(Effect.provideService(RikerOwnerGateway, gateway));
        const stream = yield* bridge.subscribe(targetProjectPath);
        const streamFailure = yield* stream.pipe(Stream.runDrain, Effect.flip, Effect.forkScoped);

        yield* Deferred.fail(
          disconnected,
          new RikerOwnerGatewayError({
            reason: "stream-closed",
            detail: "Gateway stream closed.",
          }),
        );
        expect(yield* Fiber.join(streamFailure)).toMatchObject({
          reason: "stream-closed",
          message: "Gateway stream closed.",
        });

        expect(yield* bridge.completeTurn(targetProjectPath, "Reconnect.")).toEqual({
          source: "Lead Agent",
          content: "Reconnected.",
        });
        expect(yield* Ref.get(connectCount)).toBe(2);
      }),
    ),
  );

  it.effect("retains an immediate gateway failure before the returned stream is drained", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const generationClosed = yield* Deferred.make<void>();
        const failure = new RikerOwnerGatewayError({
          reason: "stream-closed",
          detail: "Gateway failed during subscription setup.",
        });
        const gateway = RikerOwnerGateway.of({
          connect: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Deferred.succeed(generationClosed, undefined));
              return {
                childPid: 1,
                snapshot,
                events: Stream.fail(failure),
                completeTurn: () => Effect.die("The failed gateway cannot complete turns."),
              };
            }),
        });
        const bridge = yield* make().pipe(Effect.provideService(RikerOwnerGateway, gateway));

        const stream = yield* bridge.subscribe(targetProjectPath);
        yield* Deferred.await(generationClosed);
        const error = yield* stream.pipe(Stream.runDrain, Effect.flip);

        expect(error).toMatchObject({
          reason: "stream-closed",
          message: "Gateway failed during subscription setup.",
        });
      }),
    ),
  );

  it.effect("closes each gateway generation scope on disconnect and service shutdown", () =>
    Effect.gen(function* () {
      const firstFailure = yield* Deferred.make<never, RikerOwnerGatewayError>();
      const finalizedGenerations = yield* Ref.make<ReadonlyArray<number>>([]);
      const connectCount = yield* Ref.make(0);
      const gateway = RikerOwnerGateway.of({
        connect: () =>
          Effect.gen(function* () {
            const generation = yield* Ref.updateAndGet(connectCount, (count) => count + 1);
            yield* Effect.addFinalizer(() =>
              Ref.update(finalizedGenerations, (finalized) => [...finalized, generation]),
            );
            return {
              childPid: generation,
              snapshot,
              events:
                generation === 1 ? Stream.fromEffect(Deferred.await(firstFailure)) : Stream.never,
              completeTurn: () =>
                Effect.succeed({ source: "Lead Agent" as const, content: "Completed." }),
            };
          }),
      });
      const bridgeScope = yield* Scope.make("sequential");
      const bridge = yield* make().pipe(
        Effect.provideService(RikerOwnerGateway, gateway),
        Effect.provideService(Scope.Scope, bridgeScope),
      );
      const stream = yield* bridge.subscribe(targetProjectPath);
      const streamFailure = yield* stream.pipe(Stream.runDrain, Effect.flip, Effect.forkScoped);

      yield* Deferred.fail(
        firstFailure,
        new RikerOwnerGatewayError({
          reason: "stream-closed",
          detail: "First generation closed.",
        }),
      );
      yield* Fiber.join(streamFailure);
      expect(yield* Ref.get(finalizedGenerations)).toEqual([1]);

      yield* bridge.completeTurn(targetProjectPath, "Reconnect.");
      expect(yield* Ref.get(connectCount)).toBe(2);
      expect(yield* Ref.get(finalizedGenerations)).toEqual([1]);

      yield* Scope.close(bridgeScope, Exit.void);
      expect(yield* Ref.get(finalizedGenerations)).toEqual([1, 2]);
    }),
  );

  it.effect("ignores events from a retired gateway generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oldEvents = yield* Queue.unbounded<OwnerGatewayEvent>();
        const currentEvents = yield* Queue.unbounded<OwnerGatewayEvent>();
        const connectCount = yield* Ref.make(0);
        const gateway = RikerOwnerGateway.of({
          connect: () =>
            Ref.updateAndGet(connectCount, (count) => count + 1).pipe(
              Effect.map(
                (attempt): RikerOwnerGatewayConnection => ({
                  childPid: attempt,
                  snapshot,
                  events: Stream.fromQueue(attempt === 1 ? oldEvents : currentEvents),
                  completeTurn: () =>
                    attempt === 1
                      ? Effect.fail(
                          new RikerOwnerGatewayError({
                            reason: "write-failed",
                            detail: "The first gateway disconnected.",
                          }),
                        )
                      : Effect.succeed({ source: "Lead Agent", content: "Reconnected." }),
                }),
              ),
            ),
        });
        const bridge = yield* make().pipe(Effect.provideService(RikerOwnerGateway, gateway));
        yield* bridge.subscribe(targetProjectPath).pipe(Effect.asVoid);
        yield* bridge.completeTurn(targetProjectPath, "Disconnect.").pipe(Effect.flip);

        const reconnected = yield* bridge.subscribe(targetProjectPath);
        const firstTwo = yield* reconnected.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Queue.offer(oldEvents, { type: "lead-state", state: "responding" });
        yield* Queue.offer(currentEvents, { type: "lead-state", state: "available" });

        expect(Array.from(yield* Fiber.join(firstTwo))).toMatchObject([
          { type: "snapshot", snapshot: { leadState: "available" } },
          { type: "event", event: { type: "lead-state", state: "available" } },
        ]);
        expect(yield* Ref.get(connectCount)).toBe(2);
      }),
    ),
  );
});
