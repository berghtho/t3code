import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { make } from "./LeadAgentBridge.ts";
import {
  RikerOwnerGateway,
  RikerOwnerGatewayError,
  type OwnerGatewayEvent,
  type RikerOwnerGatewayConnection,
} from "./RikerOwnerGateway.ts";

const snapshot = {
  targetProjectPath: "C:\\work\\target",
  ownerSessionRevision: 1,
  leadState: "available" as const,
  conversation: [],
};

describe("LeadAgentBridge", () => {
  it.effect("owns one gateway connection and projects it for every subscriber", () =>
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
        const firstStream = yield* bridge.subscribe;
        const firstTwo = yield* firstStream.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );

        yield* Queue.offer(events, { type: "lead-state", state: "responding" });
        const firstEvents = Array.from(yield* Fiber.join(firstTwo));
        const secondStream = yield* bridge.subscribe;
        const secondSnapshot = yield* secondStream.pipe(Stream.runHead);
        const response = yield* bridge.completeTurn("Continue.");

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
        const stream = yield* bridge.subscribe;
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

        expect(yield* bridge.completeTurn("Reconnect.")).toEqual({
          source: "Lead Agent",
          content: "Reconnected.",
        });
        expect(yield* Ref.get(connectCount)).toBe(2);
      }),
    ),
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
        yield* bridge.subscribe;
        yield* bridge.completeTurn("Disconnect.").pipe(Effect.flip);

        const reconnected = yield* bridge.subscribe;
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
