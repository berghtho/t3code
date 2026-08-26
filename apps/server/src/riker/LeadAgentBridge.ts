import {
  LeadAgentError,
  type LeadAgentEvent,
  type LeadAgentResponse,
  type LeadAgentSnapshot,
  type LeadAgentStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import * as RikerOwnerGateway from "./RikerOwnerGateway.ts";

type StreamEntry =
  | { readonly _tag: "event"; readonly value: LeadAgentStreamEvent }
  | { readonly _tag: "failure"; readonly error: LeadAgentError };

interface ActiveConnection {
  readonly generation: number;
  readonly connection: RikerOwnerGateway.RikerOwnerGatewayConnection;
}

export class LeadAgentBridge extends Context.Service<
  LeadAgentBridge,
  {
    readonly completeTurn: (content: string) => Effect.Effect<LeadAgentResponse, LeadAgentError>;
    readonly subscribe: Effect.Effect<
      Stream.Stream<LeadAgentStreamEvent, LeadAgentError>,
      LeadAgentError,
      Scope.Scope
    >;
  }
>()("t3/riker/LeadAgentBridge") {}

const toLeadAgentError = (error: RikerOwnerGateway.RikerOwnerGatewayError) =>
  new LeadAgentError({ reason: error.reason, message: error.detail });

function projectSnapshot(
  snapshot: LeadAgentSnapshot,
  event: RikerOwnerGateway.OwnerGatewayEvent,
): LeadAgentSnapshot {
  switch (event.type) {
    case "conversation":
      return {
        ...snapshot,
        targetProjectPath: event.targetProjectPath,
        ownerSessionRevision: event.ownerSessionRevision,
        conversation: event.conversation,
      };
    case "session-view":
      return { ...snapshot, sessionView: event.sessionView };
    case "lead-state":
      return { ...snapshot, leadState: event.state };
    case "notice":
    case "exit":
      return snapshot;
  }
}

export const make = Effect.fn("LeadAgentBridge.make")(function* () {
  const gateway = yield* RikerOwnerGateway.RikerOwnerGateway;
  const serviceScope = yield* Scope.Scope;
  const changes = yield* PubSub.unbounded<StreamEntry>();
  const snapshotRef = yield* Ref.make<LeadAgentSnapshot | undefined>(undefined);
  const connectionMutex = yield* Semaphore.make(1);
  const projectionMutex = yield* Semaphore.make(1);
  let active: ActiveConnection | undefined;
  let nextGeneration = 1;

  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const disconnect = Effect.fn("LeadAgentBridge.disconnect")(function* (
    generation: number,
    error: RikerOwnerGateway.RikerOwnerGatewayError,
  ) {
    const leadAgentError = toLeadAgentError(error);
    const disconnected = yield* connectionMutex.withPermits(1)(
      Effect.sync(() => {
        if (active?.generation !== generation) return false;
        active = undefined;
        return true;
      }),
    );
    if (!disconnected) return;
    yield* projectionMutex.withPermits(1)(
      PubSub.publish(changes, { _tag: "failure", error: leadAgentError }),
    );
  });

  const publishEvent = (generation: number, event: RikerOwnerGateway.OwnerGatewayEvent) =>
    projectionMutex.withPermits(1)(
      Effect.gen(function* () {
        if (active?.generation !== generation) return;
        yield* Ref.update(snapshotRef, (snapshot) =>
          snapshot === undefined ? snapshot : projectSnapshot(snapshot, event),
        );
        yield* PubSub.publish(changes, {
          _tag: "event",
          value: { version: 1, type: "event", event: event satisfies LeadAgentEvent },
        });
      }),
    );

  const ensureConnection = Effect.fn("LeadAgentBridge.ensureConnection")(function* () {
    return yield* connectionMutex.withPermits(1)(
      Effect.gen(function* () {
        if (active) return active;

        const connection = yield* gateway
          .connect()
          .pipe(
            Effect.provideService(Scope.Scope, serviceScope),
            Effect.mapError(toLeadAgentError),
          );
        const generation = nextGeneration++;
        const current = { generation, connection } satisfies ActiveConnection;
        yield* projectionMutex.withPermits(1)(Ref.set(snapshotRef, connection.snapshot));
        active = current;
        yield* connection.events.pipe(
          Stream.runForEach((event) => publishEvent(generation, event)),
          Effect.catch((error) => disconnect(generation, error)),
          Effect.forkIn(serviceScope),
        );
        return current;
      }),
    );
  });

  const completeTurn: LeadAgentBridge["Service"]["completeTurn"] = Effect.fn(
    "LeadAgentBridge.completeTurn",
  )(function* (content) {
    const current = yield* ensureConnection();
    return yield* current.connection.completeTurn(content).pipe(
      Effect.mapError(toLeadAgentError),
      Effect.tapError((error) =>
        error.reason === "turn-failed"
          ? Effect.void
          : disconnect(
              current.generation,
              new RikerOwnerGateway.RikerOwnerGatewayError({
                reason: error.reason,
                detail: error.message,
              }),
            ),
      ),
    );
  });

  const subscribe: LeadAgentBridge["Service"]["subscribe"] = Effect.gen(function* () {
    yield* ensureConnection();
    const subscription = yield* subscribeBeforeSnapshot(
      changes,
      Ref.get(snapshotRef).pipe(
        Effect.flatMap((snapshot) =>
          snapshot === undefined
            ? Effect.die("Lead Agent connected without an initial snapshot.")
            : Effect.succeed({
                _tag: "event" as const,
                value: { version: 1, type: "snapshot", snapshot } satisfies LeadAgentStreamEvent,
              }),
        ),
      ),
      projectionMutex,
    );
    return Stream.concat(Stream.make(subscription.latest), subscription.changes).pipe(
      Stream.mapEffect((entry) =>
        entry._tag === "event" ? Effect.succeed(entry.value) : Effect.fail(entry.error),
      ),
    );
  });

  return LeadAgentBridge.of({ completeTurn, subscribe });
});

export const layer = Layer.effect(LeadAgentBridge, make());
