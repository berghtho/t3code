import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  UsageLimitSourceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const sourceId = UsageLimitSourceId.make("test-hub");
const managementKey = "synthetic-management-key";

const makeHarness = Effect.fn("UsageLimitSources.test.makeHarness")(function* (
  respond: () => Response,
) {
  const settingsRef = yield* Ref.make<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    usageLimitSources: {
      [sourceId]: {
        kind: "cliproxy",
        url: "https://hub.example.test",
        managementKey,
        enabled: true,
      },
    },
  });
  const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
  const subscription = yield* PubSub.subscribe(settingsChanges);
  const settings = ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settingsRef),
    updateSettings: (patch) =>
      Ref.updateAndGet(settingsRef, (current) => applyServerSettingsPatch(current, patch)).pipe(
        Effect.tap((next) => PubSub.publish(settingsChanges, next)),
      ),
    streamChanges: Stream.fromSubscription(subscription),
    subscribeChanges: Effect.succeed(Stream.fromSubscription(subscription)),
  });
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const sources = yield* UsageLimitSources.make.pipe(
    Effect.provideService(ServerSettingsService, settings),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          return HttpClientResponse.fromWeb(request, respond());
        }),
      ),
    ),
    Effect.provideService(
      BackgroundPolicy,
      BackgroundPolicy.of({
        reportClientActivity: () => Effect.void,
        removeRpcClient: () => Effect.void,
        reportHostPowerState: () => Effect.void,
        snapshot: Effect.die("Unexpected background snapshot read"),
        subscribe: Effect.die("Unexpected background subscription"),
        streamChanges: Stream.empty,
        hasDemand: () => Effect.succeed(false),
        shouldRunScopeWork: () => Effect.succeed(false),
        shouldRunOpportunisticWork: Effect.succeed(false),
      }),
    ),
  );
  return { sources, settings, requests };
});

describe("UsageLimitSources", () => {
  it.effect("refreshes hub usage and removes the source after a settings change", () =>
    Effect.gen(function* () {
      let usedPercent = 25;
      const { sources, settings, requests } = yield* makeHarness(() =>
        Response.json({
          accounts: {
            "codex-hash-user@example.test-pro.json": {
              provider: "codex",
              five_hour: { used_percent: usedPercent, known: true },
            },
          },
        }),
      );
      yield* sources.refresh;
      const initial = yield* sources.current;
      assert.equal(initial[0]?.accounts[0]?.usageLimits.windows[0]?.usedPercent, 25);
      assert.deepEqual(requests[0], {
        url: "https://hub.example.test/v0/management/quota-scheduler/status",
        authorization: `Bearer ${managementKey}`,
      });

      usedPercent = 50;
      yield* sources.refresh;
      assert.equal(
        (yield* sources.current)[0]?.accounts[0]?.usageLimits.windows[0]?.usedPercent,
        50,
      );
      const removed = yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 0),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* settings.updateSettings({ usageLimitSources: { [sourceId]: null } });
      assert.deepEqual(yield* Fiber.join(removed), Option.some([]));
      const requestCount = requests.length;
      yield* sources.refresh;
      assert.deepEqual(yield* sources.current, []);
      assert.equal(requests.length, requestCount);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "publishes a sanitized failure without exposing the management key or response body",
    () =>
      Effect.gen(function* () {
        const { sources } = yield* makeHarness(
          () => new Response(`private hub response ${managementKey}`, { status: 403 }),
        );
        yield* sources.refresh;
        const snapshot = yield* sources.current;
        assert.equal(snapshot[0]?.error, "The hub refused the request (HTTP 403).");
        assert.deepEqual(snapshot[0]?.accounts, []);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(snapshot);
        assert.notInclude(encoded, managementKey);
        assert.notInclude(encoded, "private hub response");
      }).pipe(Effect.scoped),
  );
});
