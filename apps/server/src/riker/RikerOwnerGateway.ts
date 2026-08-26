import {
  LeadAgentEvent,
  LeadAgentFailureReason,
  LeadAgentResponse,
  LeadAgentSnapshot,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const OWNER_GATEWAY_PROTOCOL_VERSION = 1;
const HANDSHAKE_TIMEOUT = Duration.seconds(75);

export type OwnerGatewaySnapshot = typeof LeadAgentSnapshot.Type;
export type OwnerGatewayEvent = typeof LeadAgentEvent.Type;
export type OwnerGatewayResponse = typeof LeadAgentResponse.Type;

const OwnerGatewayMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    protocolVersion: Schema.Number,
    childPid: Schema.Number,
    snapshot: LeadAgentSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("event"),
    event: LeadAgentEvent,
  }),
  Schema.Struct({
    type: Schema.Literal("turn-result"),
    id: Schema.String,
    response: LeadAgentResponse,
  }),
  Schema.Struct({
    type: Schema.Literal("turn-error"),
    id: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("protocol-error"),
    message: Schema.String,
  }),
]);

export class RikerOwnerGatewayError extends Schema.TaggedErrorClass<RikerOwnerGatewayError>()(
  "RikerOwnerGatewayError",
  {
    reason: LeadAgentFailureReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface RikerOwnerGatewayConnection {
  readonly childPid: number;
  readonly snapshot: OwnerGatewaySnapshot;
  /** Single-consumer protocol stream; the server projection owns its only drain. */
  readonly events: Stream.Stream<OwnerGatewayEvent, RikerOwnerGatewayError>;
  readonly completeTurn: (
    content: string,
  ) => Effect.Effect<OwnerGatewayResponse, RikerOwnerGatewayError>;
}

export class RikerOwnerGateway extends Context.Service<
  RikerOwnerGateway,
  {
    readonly connect: () => Effect.Effect<
      RikerOwnerGatewayConnection,
      RikerOwnerGatewayError,
      Scope.Scope
    >;
  }
>()("t3/riker/RikerOwnerGateway") {}

const decodeOwnerGatewayMessage = Schema.decodeUnknownEffect(OwnerGatewayMessage);

const gatewayError = (
  reason: typeof LeadAgentFailureReason.Type,
  detail: string,
  cause?: unknown,
) =>
  new RikerOwnerGatewayError({
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const connectWithSpawner = Effect.fn("RikerOwnerGateway.connectWithSpawner")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const executable = "riker";
  const args = ["gateway"];
  const resolved = yield* resolveSpawnCommand(executable, args);
  const command = ChildProcess.make(resolved.command, resolved.args, {
    shell: resolved.shell,
    stdin: { stream: "pipe", endOnDone: false },
    stdout: "pipe",
    stderr: "pipe",
  });
  const handle = yield* Effect.acquireRelease(
    spawner
      .spawn(command)
      .pipe(
        Effect.mapError((cause) =>
          gatewayError("spawn-failed", `Failed to start '${executable} ${args.join(" ")}'.`, cause),
        ),
      ),
    (child) => child.kill({ forceKillAfter: Duration.seconds(5) }).pipe(Effect.ignore),
  );

  const ready = yield* Deferred.make<typeof OwnerGatewayMessage.Type & { type: "ready" }>();
  const terminal = yield* Deferred.make<never, RikerOwnerGatewayError>();
  const terminalCleanup = yield* Deferred.make<void>();
  const events = yield* Queue.unbounded<
    | { readonly _tag: "event"; readonly event: OwnerGatewayEvent }
    | { readonly _tag: "failure"; readonly error: RikerOwnerGatewayError }
  >();
  const pendingTurns = new Map<
    string,
    Deferred.Deferred<OwnerGatewayResponse, RikerOwnerGatewayError>
  >();
  const nextTurnNumber = yield* Ref.make(1);
  const writeMutex = yield* Semaphore.make(1);
  let receivedReady = false;
  let terminalError: RikerOwnerGatewayError | undefined;

  yield* Effect.addFinalizer(() => Queue.shutdown(events));

  const failConnection = Effect.fn("RikerOwnerGateway.failConnection")(function* (
    error: RikerOwnerGatewayError,
  ) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const claimed = yield* Effect.sync(() => {
          if (terminalError) return false;
          terminalError = error;
          return true;
        });
        if (!claimed) return yield* Deferred.await(terminalCleanup);

        yield* Deferred.fail(terminal, error);
        yield* Queue.offer(events, { _tag: "failure", error });
        yield* handle.kill({ forceKillAfter: Duration.seconds(5) }).pipe(Effect.ignore);
        yield* writeMutex.withPermits(1)(
          Effect.gen(function* () {
            const pending = Array.from(pendingTurns.values());
            pendingTurns.clear();
            yield* Effect.forEach(pending, (response) => Deferred.fail(response, error), {
              discard: true,
            });
          }),
        );
        yield* Deferred.succeed(terminalCleanup, undefined);
      }),
    );
  });

  const processMessage = Effect.fn("RikerOwnerGateway.processMessage")(function* (raw: unknown) {
    const message = yield* decodeOwnerGatewayMessage(raw).pipe(
      Effect.mapError((cause) =>
        gatewayError("protocol-failed", "Riker emitted an invalid Owner Gateway record.", cause),
      ),
    );
    if (!receivedReady && message.type !== "ready") {
      return yield* gatewayError(
        "protocol-failed",
        "Riker emitted an Owner Gateway record before becoming ready.",
      );
    }

    switch (message.type) {
      case "ready":
        if (receivedReady) {
          return yield* gatewayError(
            "protocol-failed",
            "Riker emitted more than one Owner Gateway ready record.",
          );
        }
        receivedReady = true;
        if (message.protocolVersion !== OWNER_GATEWAY_PROTOCOL_VERSION) {
          return yield* gatewayError(
            "protocol-failed",
            `Riker Owner Gateway protocol ${message.protocolVersion} is incompatible with expected protocol ${OWNER_GATEWAY_PROTOCOL_VERSION}.`,
          );
        }
        yield* Deferred.succeed(ready, message);
        return;
      case "event":
        yield* Queue.offer(events, { _tag: "event", event: message.event });
        if (message.event.type === "exit") {
          return yield* gatewayError(
            "process-exited",
            `The Riker Lead Agent exited (${message.event.exit.kind}).`,
          );
        }
        return;
      case "turn-result": {
        const pending = pendingTurns.get(message.id);
        if (!pending) {
          return yield* gatewayError(
            "protocol-failed",
            `Riker returned an unknown Owner turn id '${message.id}'.`,
          );
        }
        pendingTurns.delete(message.id);
        yield* Deferred.succeed(pending, message.response);
        return;
      }
      case "turn-error": {
        const pending = pendingTurns.get(message.id);
        if (!pending) {
          return yield* gatewayError(
            "protocol-failed",
            `Riker failed an unknown Owner turn id '${message.id}'.`,
          );
        }
        pendingTurns.delete(message.id);
        yield* Deferred.fail(pending, gatewayError("turn-failed", message.message));
        return;
      }
      case "protocol-error":
        return yield* gatewayError("protocol-failed", message.message);
    }
  });

  yield* handle.stdout.pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.runForEach(processMessage),
    Effect.flatMap(() =>
      Effect.fail(
        gatewayError("stream-closed", "Riker closed the Owner Gateway stream unexpectedly."),
      ),
    ),
    Effect.catch((cause) =>
      failConnection(
        cause instanceof RikerOwnerGatewayError
          ? cause
          : gatewayError("protocol-failed", "Failed to read Riker Owner Gateway output.", cause),
      ),
    ),
    Effect.forkScoped,
  );
  yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

  const readyMessage = yield* Effect.raceFirst(
    Deferred.await(ready),
    Deferred.await(terminal),
  ).pipe(
    Effect.timeoutOption(HANDSHAKE_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            gatewayError(
              "handshake-timeout",
              `Riker did not become ready within ${Duration.toMillis(HANDSHAKE_TIMEOUT)}ms.`,
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.tapError(failConnection),
  );

  const completeTurn = Effect.fn("RikerOwnerGateway.completeTurn")(function* (content: string) {
    if (content.length === 0) {
      return yield* gatewayError("turn-failed", "An Owner turn cannot be empty.");
    }
    const turnNumber = yield* Ref.getAndUpdate(nextTurnNumber, (current) => current + 1);
    const id = `t3-owner-turn-${turnNumber}`;
    const response = yield* Deferred.make<OwnerGatewayResponse, RikerOwnerGatewayError>();
    let acknowledged = false;

    yield* writeMutex
      .withPermits(1)(
        Effect.gen(function* () {
          if (terminalError) {
            return yield* Effect.fail(terminalError);
          }

          pendingTurns.set(id, response);
          yield* Stream.run(
            Stream.encodeText(Stream.make(`${JSON.stringify({ type: "turn", id, content })}\n`)),
            handle.stdin,
          ).pipe(
            Effect.mapError((cause) =>
              gatewayError("write-failed", "Failed to send an Owner turn to Riker.", cause),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                acknowledged = true;
              }),
            ),
            Effect.uninterruptible,
          );
        }),
      )
      .pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (!acknowledged) pendingTurns.delete(id);
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            pendingTurns.delete(id);
          }),
        ),
        Effect.tapError(failConnection),
      );

    // Riker continues an acknowledged turn if its presentation client detaches.
    // Protocol settlement owns cleanup even when this caller stops waiting.
    return yield* Effect.raceFirst(Deferred.await(response), Deferred.await(terminal));
  });

  const eventStream = Stream.fromQueue(events).pipe(
    Stream.mapEffect((entry) =>
      entry._tag === "event" ? Effect.succeed(entry.event) : Effect.fail(entry.error),
    ),
  );

  return {
    childPid: readyMessage.childPid,
    snapshot: readyMessage.snapshot,
    events: eventStream,
    completeTurn,
  } satisfies RikerOwnerGatewayConnection;
});

export const connect = Effect.fn("RikerOwnerGateway.connect")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* connectWithSpawner(spawner);
});

export const make = Effect.fn("RikerOwnerGateway.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return RikerOwnerGateway.of({
    connect: () => connectWithSpawner(spawner),
  });
});

export const layer = Layer.effect(RikerOwnerGateway, make());
