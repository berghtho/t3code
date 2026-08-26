import {
  LeadAgentError,
  type LeadAgentEvent,
  type LeadAgentResponse,
  type LeadAgentSnapshot,
  type LeadAgentStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  readonly scope: Scope.Closeable;
  readonly connection: RikerOwnerGateway.RikerOwnerGatewayConnection;
}

interface ProjectEntry {
  readonly canonicalWorkspaceRoot: string;
  readonly changes: PubSub.PubSub<StreamEntry>;
  readonly latestRef: Ref.Ref<StreamEntry | undefined>;
  readonly connectionMutex: Semaphore.Semaphore;
  readonly projectionMutex: Semaphore.Semaphore;
  active: ActiveConnection | undefined;
  nextGeneration: number;
}

export class LeadAgentBridge extends Context.Service<
  LeadAgentBridge,
  {
    readonly completeTurn: (
      canonicalWorkspaceRoot: string,
      content: string,
    ) => Effect.Effect<LeadAgentResponse, LeadAgentError>;
    readonly subscribe: (
      canonicalWorkspaceRoot: string,
    ) => Effect.Effect<
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
  const entries = new Map<string, ProjectEntry>();
  const entriesMutex = yield* Semaphore.make(1);

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      entries.values(),
      (entry) =>
        Effect.gen(function* () {
          if (entry.active) yield* Scope.close(entry.active.scope, Exit.void).pipe(Effect.ignore);
          yield* PubSub.shutdown(entry.changes);
        }),
      { discard: true },
    ),
  );

  const getEntry = Effect.fn("LeadAgentBridge.getEntry")(function* (
    canonicalWorkspaceRoot: string,
  ) {
    return yield* entriesMutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = entries.get(canonicalWorkspaceRoot);
        if (existing) return existing;

        const entry: ProjectEntry = {
          canonicalWorkspaceRoot,
          changes: yield* PubSub.unbounded<StreamEntry>(),
          latestRef: yield* Ref.make<StreamEntry | undefined>(undefined),
          connectionMutex: yield* Semaphore.make(1),
          projectionMutex: yield* Semaphore.make(1),
          active: undefined,
          nextGeneration: 1,
        };
        entries.set(canonicalWorkspaceRoot, entry);
        return entry;
      }),
    );
  });

  const disconnect = Effect.fn("LeadAgentBridge.disconnect")(function* (
    entry: ProjectEntry,
    generation: number,
    error: RikerOwnerGateway.RikerOwnerGatewayError,
  ) {
    const failure = {
      _tag: "failure" as const,
      error: toLeadAgentError(error),
    } satisfies StreamEntry;
    const disconnectedScope = yield* entry.connectionMutex.withPermits(1)(
      entry.projectionMutex.withPermits(1)(
        Effect.gen(function* () {
          if (entry.active?.generation !== generation) return undefined;
          const scope = entry.active.scope;
          entry.active = undefined;
          yield* Ref.set(entry.latestRef, failure);
          yield* PubSub.publish(entry.changes, failure);
          return scope;
        }),
      ),
    );
    if (disconnectedScope) yield* Scope.close(disconnectedScope, Exit.void).pipe(Effect.ignore);
  });

  const publishEvent = (
    entry: ProjectEntry,
    generation: number,
    event: RikerOwnerGateway.OwnerGatewayEvent,
  ) =>
    entry.projectionMutex.withPermits(1)(
      Effect.gen(function* () {
        if (entry.active?.generation !== generation) return;
        const latest = yield* Ref.get(entry.latestRef);
        if (latest?._tag !== "event" || latest.value.type !== "snapshot") return;
        yield* Ref.set(entry.latestRef, {
          _tag: "event",
          value: {
            version: 1,
            type: "snapshot",
            snapshot: projectSnapshot(latest.value.snapshot, event),
          },
        });
        yield* PubSub.publish(entry.changes, {
          _tag: "event",
          value: { version: 1, type: "event", event: event satisfies LeadAgentEvent },
        });
      }),
    );

  const ensureConnection = Effect.fn("LeadAgentBridge.ensureConnection")(function* (
    entry: ProjectEntry,
  ) {
    return yield* entry.connectionMutex.withPermits(1)(
      Effect.gen(function* () {
        if (entry.active) return entry.active;

        const generationScope = yield* Scope.make("sequential");
        const connection = yield* gateway.connect(entry.canonicalWorkspaceRoot).pipe(
          Effect.provideService(Scope.Scope, generationScope),
          Effect.mapError(toLeadAgentError),
          Effect.onError(() => Scope.close(generationScope, Exit.void).pipe(Effect.ignore)),
        );
        const generation = entry.nextGeneration++;
        const current = {
          generation,
          scope: generationScope,
          connection,
        } satisfies ActiveConnection;
        yield* entry.projectionMutex.withPermits(1)(
          Effect.gen(function* () {
            entry.active = current;
            yield* Ref.set(entry.latestRef, {
              _tag: "event",
              value: { version: 1, type: "snapshot", snapshot: connection.snapshot },
            });
          }),
        );
        yield* connection.events.pipe(
          Stream.runForEach((event) => publishEvent(entry, generation, event)),
          Effect.catch((error) => disconnect(entry, generation, error)),
          Effect.forkIn(serviceScope),
        );
        return current;
      }),
    );
  });

  const completeTurn: LeadAgentBridge["Service"]["completeTurn"] = Effect.fn(
    "LeadAgentBridge.completeTurn",
  )(function* (canonicalWorkspaceRoot, content) {
    const entry = yield* getEntry(canonicalWorkspaceRoot);
    const current = yield* ensureConnection(entry);
    return yield* current.connection.completeTurn(content).pipe(
      Effect.tapError((error) =>
        error.reason === "turn-failed" ? Effect.void : disconnect(entry, current.generation, error),
      ),
      Effect.mapError(toLeadAgentError),
    );
  });

  const subscribe: LeadAgentBridge["Service"]["subscribe"] = Effect.fn("LeadAgentBridge.subscribe")(
    function* (canonicalWorkspaceRoot) {
      const entry = yield* getEntry(canonicalWorkspaceRoot);
      yield* ensureConnection(entry);
      const subscription = yield* subscribeBeforeSnapshot(
        entry.changes,
        Ref.get(entry.latestRef).pipe(
          Effect.flatMap((latest) =>
            latest === undefined
              ? Effect.die("Lead Agent connected without an initial snapshot.")
              : Effect.succeed(latest),
          ),
        ),
        entry.projectionMutex,
      );
      return Stream.concat(Stream.make(subscription.latest), subscription.changes).pipe(
        Stream.mapEffect((entry) =>
          entry._tag === "event" ? Effect.succeed(entry.value) : Effect.fail(entry.error),
        ),
      );
    },
  );

  return LeadAgentBridge.of({ completeTurn, subscribe });
});

export const layer = Layer.effect(LeadAgentBridge, make());
