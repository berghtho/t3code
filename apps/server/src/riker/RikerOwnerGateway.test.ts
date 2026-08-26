import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { connect, RikerOwnerGatewayError } from "./RikerOwnerGateway.ts";

const encoder = new TextEncoder();

function makeGatewayProcess(
  onCommand: (command: unknown) => Effect.Effect<void>,
  readyProtocolVersion = 1,
) {
  return Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array>();
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const writes: Array<unknown> = [];
    const offer = (message: unknown) =>
      Queue.offer(output, encoder.encode(`${JSON.stringify(message)}\n`)).pipe(Effect.asVoid);

    yield* offer({
      type: "ready",
      protocolVersion: readyProtocolVersion,
      childPid: 77,
      snapshot: {
        targetProjectPath: "C:\\work\\target",
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
          const command = JSON.parse(new TextDecoder().decode(chunk)) as unknown;
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

        const connection = yield* connect().pipe(
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
        expect(spawned[0]?.args).toEqual(["gateway"]);
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
        const gateway = yield* makeGatewayProcess(() => Effect.void, 2);
        const spawner = ChildProcessSpawner.make(() => Effect.succeed(gateway.handle));

        const error = yield* connect().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(RikerOwnerGatewayError);
        expect(error).toMatchObject({
          reason: "protocol-failed",
          detail: "Riker Owner Gateway protocol 2 is incompatible with expected protocol 1.",
        });
        expect(yield* Deferred.isDone(gateway.exit)).toBe(true);
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
        const connection = yield* connect().pipe(
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
        const connection = yield* connect().pipe(
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
        const connection = yield* connect().pipe(
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
        const connection = yield* connect().pipe(
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
