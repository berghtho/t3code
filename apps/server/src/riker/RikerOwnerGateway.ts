import {
  LeadAgentEvent,
  LeadAgentFailureReason,
  LeadAgentResponse,
  LeadAgentSnapshot,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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

const OWNER_GATEWAY_PROTOCOL_VERSION = 2;
const HANDSHAKE_TIMEOUT = Duration.seconds(75);
const STDERR_DIAGNOSTIC_LIMIT_BYTES = 4_096;

export type OwnerGatewaySnapshot = LeadAgentSnapshot;
export type OwnerGatewayEvent = LeadAgentEvent;
export type OwnerGatewayResponse = LeadAgentResponse;

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

const OwnerTurnCommand = Schema.Struct({
  type: Schema.Literal("turn"),
  id: Schema.String,
  content: Schema.String,
});

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

const isRikerOwnerGatewayError = Schema.is(RikerOwnerGatewayError);

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
    readonly connect: (
      canonicalTargetProjectPath: string,
    ) => Effect.Effect<RikerOwnerGatewayConnection, RikerOwnerGatewayError, Scope.Scope>;
  }
>()("t3/riker/RikerOwnerGateway") {}

const decodeOwnerGatewayMessage = Schema.decodeUnknownEffect(OwnerGatewayMessage);

const gatewayError = (reason: LeadAgentFailureReason, detail: string, cause?: unknown) =>
  new RikerOwnerGatewayError({
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export function targetProjectPathsEqual(
  requestedPath: string,
  receivedPath: string,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (input: string) => {
    const normalized = platform === "win32" ? input.replaceAll("/", "\\") : input;
    const trailingSeparatorLength =
      normalized.match(platform === "win32" ? /\\+$/ : /\/+$/)?.[0].length ?? 0;
    const withoutTrailingSeparators =
      trailingSeparatorLength === 0 ? normalized : normalized.slice(0, -trailingSeparatorLength);
    const rootPreserved =
      platform === "win32" && /^[a-z]:\\+$/i.test(normalized)
        ? `${normalized.slice(0, 2)}\\`
        : withoutTrailingSeparators.length > 0
          ? withoutTrailingSeparators
          : normalized.slice(0, 1);
    return platform === "win32" ? rootPreserved.toLowerCase() : rootPreserved;
  };
  return normalize(requestedPath) === normalize(receivedPath);
}

function appendBoundedStderr(current: Uint8Array, chunk: Uint8Array): Uint8Array {
  const incoming =
    chunk.length > STDERR_DIAGNOSTIC_LIMIT_BYTES
      ? chunk.slice(chunk.length - STDERR_DIAGNOSTIC_LIMIT_BYTES)
      : chunk;
  const retainedLength = Math.min(current.length, STDERR_DIAGNOSTIC_LIMIT_BYTES - incoming.length);
  const combined = new Uint8Array(retainedLength + incoming.length);
  combined.set(current.subarray(current.length - retainedLength));
  combined.set(incoming, retainedLength);
  return combined;
}

function sanitizeStderr(bytes: Uint8Array): string {
  return new TextDecoder()
    .decode(bytes)
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(token|secret|password|authorization|api[-_ ]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1=[redacted]",
    )
    .replaceAll("\0", "")
    .trim();
}

const connectWithSpawner = Effect.fn("RikerOwnerGateway.connectWithSpawner")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  canonicalTargetProjectPath: string,
) {
  const platform = yield* HostProcessPlatform;
  const executable = "riker";
  const args = ["gateway", "--project", canonicalTargetProjectPath];
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
          gatewayError("spawn-failed", `Failed to start the '${executable}' Owner Gateway.`, cause),
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
  const stderr = yield* Ref.make<Uint8Array<ArrayBufferLike>>(new Uint8Array());
  const writeMutex = yield* Semaphore.make(1);
  let receivedReady = false;
  let terminalError: RikerOwnerGatewayError | undefined;

  yield* Effect.addFinalizer(() => Queue.shutdown(events));

  const recordStderrDiagnostic = Effect.fn("RikerOwnerGateway.recordStderrDiagnostic")(function* (
    error: RikerOwnerGatewayError,
  ) {
    if (receivedReady && error.reason !== "stream-closed") return error;
    const diagnostic = sanitizeStderr(yield* Ref.get(stderr));
    if (diagnostic.length === 0) return error;
    yield* Effect.logWarning(`Riker Owner Gateway stderr (bounded): ${diagnostic}`, {
      reason: error.reason,
    });
    return error;
  });

  const failConnection = Effect.fn("RikerOwnerGateway.failConnection")(function* (
    error: RikerOwnerGatewayError,
  ) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const terminalFailure = yield* recordStderrDiagnostic(error);
        const claimed = yield* Effect.sync(() => {
          if (terminalError) return false;
          terminalError = terminalFailure;
          return true;
        });
        if (!claimed) return yield* Deferred.await(terminalCleanup);

        yield* Deferred.fail(terminal, terminalFailure);
        yield* Queue.offer(events, { _tag: "failure", error: terminalFailure });
        yield* handle.kill({ forceKillAfter: Duration.seconds(5) }).pipe(Effect.ignore);
        yield* writeMutex.withPermits(1)(
          Effect.gen(function* () {
            const pending = Array.from(pendingTurns.values());
            pendingTurns.clear();
            yield* Effect.forEach(pending, (response) => Deferred.fail(response, terminalFailure), {
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
        if (message.protocolVersion !== OWNER_GATEWAY_PROTOCOL_VERSION) {
          return yield* gatewayError(
            "protocol-failed",
            `Riker Owner Gateway protocol ${message.protocolVersion} is incompatible with expected protocol ${OWNER_GATEWAY_PROTOCOL_VERSION}.`,
          );
        }
        if (
          !targetProjectPathsEqual(
            canonicalTargetProjectPath,
            message.snapshot.targetProjectPath,
            platform,
          )
        ) {
          return yield* gatewayError(
            "protocol-failed",
            "Riker Owner Gateway ready snapshot targeted a different project.",
          );
        }
        receivedReady = true;
        yield* Deferred.succeed(ready, message);
        return;
      case "event":
        if (
          message.event.type === "conversation" &&
          !targetProjectPathsEqual(
            canonicalTargetProjectPath,
            message.event.targetProjectPath,
            platform,
          )
        ) {
          return yield* gatewayError(
            "protocol-failed",
            "Riker Owner Gateway conversation event targeted a different project.",
          );
        }
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
            "Riker returned a result for an unknown Owner turn.",
            { ownerTurnId: message.id },
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
            "Riker returned an error for an unknown Owner turn.",
            { ownerTurnId: message.id },
          );
        }
        pendingTurns.delete(message.id);
        yield* Deferred.fail(pending, gatewayError("turn-failed", message.message));
        return;
      }
      case "protocol-error":
        return yield* gatewayError(
          "protocol-failed",
          "Riker reported an Owner Gateway protocol error.",
          { protocolMessage: message.message },
        );
    }
  });

  yield* handle.stderr.pipe(
    Stream.runForEach((chunk) =>
      Ref.update(stderr, (current) => appendBoundedStderr(current, chunk)),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
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
        isRikerOwnerGatewayError(cause)
          ? cause
          : gatewayError("protocol-failed", "Failed to read Riker Owner Gateway output.", cause),
      ),
    ),
    Effect.forkScoped,
  );

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
    Effect.catch((error) => failConnection(error).pipe(Effect.andThen(Deferred.await(terminal)))),
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
            return yield* terminalError;
          }

          pendingTurns.set(id, response);
          yield* Stream.run(
            Stream.make({ type: "turn" as const, id, content }).pipe(
              Stream.pipeThroughChannel(Ndjson.encodeSchema(OwnerTurnCommand)()),
            ),
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

export const connect = Effect.fn("RikerOwnerGateway.connect")(function* (
  canonicalTargetProjectPath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* connectWithSpawner(spawner, canonicalTargetProjectPath);
});

export const make = Effect.fn("RikerOwnerGateway.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return RikerOwnerGateway.of({
    connect: (canonicalTargetProjectPath) =>
      connectWithSpawner(spawner, canonicalTargetProjectPath),
  });
});

export const layer = Layer.effect(RikerOwnerGateway, make());
