import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { connect, RikerOwnerGatewayError, targetProjectPathsEqual } from "./RikerOwnerGateway.ts";

const encoder = new TextEncoder();
const targetProjectPath = "C:\\work\\target";
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const OwnerTurnCommand = Schema.Struct({
  type: Schema.Literal("turn"),
  id: Schema.String,
  content: Schema.String,
});
const decodeOwnerTurnCommand = Schema.decodeUnknownSync(Schema.fromJsonString(OwnerTurnCommand));

function makeGatewayProcess(
  onCommand: (command: unknown) => Effect.Effect<void>,
  readyProtocolVersion = 2,
  readyTargetProjectPath = targetProjectPath,
) {
  return Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array>();
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const writes: Array<unknown> = [];
    const offer = (message: unknown) =>
      Queue.offer(output, encoder.encode(`${encodeUnknownJson(message)}\n`)).pipe(Effect.asVoid);

    yield* offer({
      type: "ready",
      protocolVersion: readyProtocolVersion,
      childPid: 77,
      snapshot: {
        targetProjectPath: readyTargetProjectPath,
        ownerSessionRevision: 1,
        leadState: "available",
        conversation: [],
      },
    });

    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(12),
      exitCode: Deferred.await(exit),
      isRunning: Effect.succeed(true),
      kill: () => Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
      unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Effect.gen(function* () {
          const command = decodeOwnerTurnCommand(new TextDecoder().decode(chunk));
          writes.push(command);
          yield* onCommand(command);
        }),
      ),
      stdout: Stream.fromQueue(output),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

    return { handle, offer, writes, exit };
  });
}

describe("RikerOwnerGateway", () => {
  it.effect("launches the hidden gateway and completes one correlated Lead turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let gateway: Effect.Success<ReturnType<typeof makeGatewayProcess>> | undefined;
        const spawned: Array<ChildProcess.StandardCommand> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("Expected a standard child process command.");
            }
            spawned.push(command);
            gateway = yield* makeGatewayProcess((raw) => {
              const turn = raw as { readonly id: string };
              return gateway!
                .offer({
                  type: "event",
                  event: { type: "lead-state", state: "responding" },
                })
                .pipe(
                  Effect.andThen(
                    gateway!.offer({
                      type: "turn-result",
                      id: turn.id,
                      response: { source: "Lead Agent", content: "Delegated and monitoring it." },
                    }),
                  ),
                );
            });
            return gateway.handle;
          }),
        );

        const connection = yield* connect(targetProjectPath).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
        );
        const eventFiber = yield* connection.events.pipe(Stream.runHead, Effect.forkScoped);
        yield* Effect.yieldNow;
        const response = yield* connection.completeTurn("Continue the integration.");
        const event = yield* Fiber.join(eventFiber);

        expect(connection.childPid).toBe(77);
        expect(connection.snapshot.targetProjectPath).toBe("C:\\work\\target");
        expect(response).toEqual({
          source: "Lead Agent",
          content: "Delegated and monitoring it.",
        });
        expect(event._tag).toBe("Some");
        expect(event._tag === "Some" ? event.value : undefined).toEqual({
          type: "lead-state",
          state: "responding",
        });
        expect(gateway?.writes).toEqual([
          { type: "turn", id: "t3-owner-turn-1", content: "Continue the integration." },
        ]);
        expect(spawned).toHaveLength(1);
        expect(spawned[0]?.command).toBe("riker");
        expect(spawned[0]?.args).toEqual(["gateway", "--project", targetProjectPath]);
        expect(spawned[0]?.options).toMatchObject({
          shell: false,
          stdin: { stream: "pipe", endOnDone: false },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(spawned[0]?.options.detached).toBeUndefined();
      }),
    ),
  );

  it.effect("rejects an incompatible Owner Gateway protocol before returning a connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* makeGatewayProcess(() => Effect.void, 1);
        const spawner = ChildProcessSpawner.make(() => Effect.succeed(gateway.handle));

        const error = yield* connect(targetProjectPath).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(RikerOwnerGatewayError);
        expect(error).toMatchObject({
          reason: "protocol-failed",
          detail: "Riker Owner Gateway protocol 1 is incompatible with expected protocol 2.",
        });
        expect(yield* Deferred.isDone(gateway.exit)).toBe(true);
      }),
    ),
  );

  it("normalizes Windows casing, slash direction, and trailing separators", () => {
    expect(targetProjectPathsEqual("C:\\Work\\Target", "c:\\work\\target", "win32")).toBe(true);
    expect(targetProjectPathsEqual("C:\\Work\\Target\\", "c:/work/target/", "win32")).toBe(true);
    expect(targetProjectPathsEqual("C:\\", "c:/", "win32")).toBe(true);
    expect(targetProjectPathsEqual("/work/target/", "/work/target", "linux")).toBe(true);
    expect(targetProjectPathsEqual("/Work/Target", "/work/target", "linux")).toBe(false);
  });

  it.effect("rejects a ready snapshot bound to another project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* makeGatewayProcess(() => Effect.void, 2, "C:\\work\\different");
        const spawner = ChildProcessSpawner.make(() => Effect.succeed(gateway.handle));

        const error = yield* connect(targetProjectPath).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "win32"),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "protocol-failed",
          detail: "Riker Owner Gateway ready snapshot targeted a different project.",
        });
        expect(yield* Deferred.isDone(gateway.exit)).toBe(true);
      }),
    ),
  );

  it.effect(
    "accepts Windows path casing but rejects a later conversation for another project",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* makeGatewayProcess(() => Effect.void, 2, "c:/WORK/TARGET/");
          const spawner = ChildProcessSpawner.make(() => Effect.succeed(gateway.handle));
          const connection = yield* connect(targetProjectPath).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HostProcessPlatform, "win32"),
          );

          yield* gateway.offer({
            type: "event",
            event: {
              type: "conversation",
              conversation: [],
              targetProjectPath: "C:\\work\\different",
              ownerSessionRevision: 2,
              replaced: false,
            },
          });
          const error = yield* connection.events.pipe(Stream.runDrain, Effect.flip);

          expect(error).toMatchObject({
            reason: "protocol-failed",
            detail: "Riker Owner Gateway conversation event targeted a different project.",
          });
          expect(yield* Deferred.isDone(gateway.exit)).toBe(true);
        }),
      ),
  );

  it.effect("includes bounded redacted stderr when the gateway closes during handshake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stderrConsumed = yield* Deferred.make<void>();
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const diagnostic = `${"x".repeat(5_000)}\napi_key=super-secret\nModel configuration is invalid.`;
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(12),
          exitCode: Deferred.await(exit),
          isRunning: Effect.succeed(true),
          kill: () => Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.unwrap(
            Deferred.await(stderrConsumed).pipe(
              Effect.as(Stream.empty as Stream.Stream<Uint8Array>),
            ),
          ),
          stderr: Stream.make(encoder.encode(diagnostic)).pipe(
            Stream.ensuring(Deferred.succeed(stderrConsumed, undefined)),
          ),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        const spawner = ChildProcessSpawner.make(() => Effect.succeed(handle));

        const error = yield* connect(targetProjectPath).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        expect(error.reason).toBe("stream-closed");
        expect(error.detail).toContain("Model configuration is invalid.");
        expect(error.detail).toContain("api_key=[redacted]");
        expect(error.detail).not.toContain("super-secret");
        expect(error.detail.length).toBeLessThan(4_300);
      }),
    ),
  );

  it.effect("includes available stderr when a ready gateway stream closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stderrConsumed = yield* Deferred.make<void>();
        const closeOutput = yield* Deferred.make<void>();
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const readyRecord = encoder.encode(
          `${encodeUnknownJson({
            type: "ready",
            protocolVersion: 2,
            childPid: 77,
            snapshot: {
              targetProjectPath,
              ownerSessionRevision: 1,
              leadState: "available",
              conversation: [],
            },
          })}\n`,
        );
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(12),
          exitCode: Deferred.await(exit),
          isRunning: Effect.succeed(true),
          kill: () => Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.concat(
            Stream.make(readyRecord),
            Stream.fromEffect(Deferred.await(closeOutput)).pipe(Stream.drain),
          ),
          stderr: Stream.make(encoder.encode("Gateway database is locked.")).pipe(
            Stream.ensuring(Deferred.succeed(stderrConsumed, undefined)),
          ),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        const spawner = ChildProcessSpawner.make(() => Effect.succeed(handle));
        const connection = yield* connect(targetProjectPath).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        yield* Deferred.await(stderrConsumed);
        yield* Deferred.succeed(closeOutput, undefined);
        const error = yield* connection.events.pipe(Stream.runDrain, Effect.flip);

        expect(error).toMatchObject({
          reason: "stream-closed",
          detail:
            "Riker closed the Owner Gateway stream unexpectedly.\nRiker stderr (bounded): Gateway database is locked.",
        });
      }),
    ),
  );

  it.effect("buffers events emitted immediately after the ready record", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const gateway = yield* makeGatewayProcess(() => Effect.void);
            yield* gateway.offer({
              type: "event",
              event: { type: "notice", content: "Owner session changed." },
            });
            return gateway.handle;
          }),
        );
        const connection = yield* connect(targetProjectPath).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        expect(yield* connection.events.pipe(Stream.runHead)).toMatchObject({
          _tag: "Some",
          value: { type: "notice", content: "Owner session changed." },
        });
      }),
    ),
  );

  it.effect("fails pending and future turns when the protocol terminates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let gateway: Effect.Success<ReturnType<typeof makeGatewayProcess>> | undefined;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            gateway = yield* makeGatewayProcess(() =>
              gateway!.offer({ type: "protocol-error", message: "Malformed Owner turn." }),
            );
            return gateway.handle;
          }),
        );
        const connection = yield* connect(targetProjectPath).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        const firstError = yield* connection.completeTurn("First turn").pipe(Effect.flip);
        const eventError = yield* connection.events.pipe(Stream.runDrain, Effect.flip);
        const secondError = yield* connection.completeTurn("Second turn").pipe(Effect.flip);

        expect(firstError).toMatchObject({
          reason: "protocol-failed",
          detail: "Malformed Owner turn.",
        });
        expect(eventError).toEqual(firstError);
        expect(secondError).toEqual(firstError);
        expect(gateway?.writes).toHaveLength(1);
      }),
    ),
  );

  it.effect("does not write a queued turn after terminal failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstCommandReceived = yield* Deferred.make<void>();
        const releaseFirstWrite = yield* Deferred.make<void>();
        let gateway: Effect.Success<ReturnType<typeof makeGatewayProcess>> | undefined;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            gateway = yield* makeGatewayProcess(() =>
              Deferred.succeed(firstCommandReceived, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstWrite)),
              ),
            );
            return gateway.handle;
          }),
        );
        const connection = yield* connect(targetProjectPath).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        const firstTurn = yield* connection
          .completeTurn("First turn")
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(firstCommandReceived);
        const queuedTurn = yield* connection
          .completeTurn("Queued turn")
          .pipe(Effect.flip, Effect.forkScoped);
        const connectionFailure = yield* connection.events.pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.forkScoped,
        );
        yield* gateway!.offer({ type: "protocol-error", message: "Gateway stopped." });
        yield* Fiber.join(connectionFailure);
        yield* Deferred.succeed(releaseFirstWrite, undefined);

        expect(yield* Fiber.join(firstTurn)).toMatchObject({ reason: "protocol-failed" });
        expect(yield* Fiber.join(queuedTurn)).toMatchObject({ reason: "protocol-failed" });
        expect(gateway!.writes).toHaveLength(1);
      }),
    ),
  );

  it.effect("retains correlation when a caller stops waiting for an authoritative turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstCommandReceived = yield* Deferred.make<void>();
        let gateway: Effect.Success<ReturnType<typeof makeGatewayProcess>> | undefined;
        let firstTurnId: string | undefined;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            gateway = yield* makeGatewayProcess((raw) => {
              const turn = raw as { readonly id: string; readonly content: string };
              if (turn.content === "First turn") {
                firstTurnId = turn.id;
                return Deferred.succeed(firstCommandReceived, undefined).pipe(Effect.asVoid);
              }
              return gateway!.offer({
                type: "turn-result",
                id: turn.id,
                response: { source: "Lead Agent", content: "Second turn completed." },
              });
            });
            return gateway.handle;
          }),
        );
        const connection = yield* connect(targetProjectPath).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        const abandoned = yield* connection.completeTurn("First turn").pipe(Effect.forkScoped);
        yield* Deferred.await(firstCommandReceived);
        yield* Fiber.interrupt(abandoned);
        yield* gateway!.offer({
          type: "turn-result",
          id: firstTurnId,
          response: { source: "Lead Agent", content: "First turn completed." },
        });

        expect(yield* connection.completeTurn("Second turn")).toEqual({
          source: "Lead Agent",
          content: "Second turn completed.",
        });
      }),
    ),
  );
});
