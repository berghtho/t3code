import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  UsageBucket,
  type UsageDay,
  UsageSource,
  UsageSourceFingerprint,
  UsageSummary,
  UsageSummaryInput,
  usageSummaryForClient,
} from "./usage.ts";

const UsageProviderKindV4 = Schema.Literals(["claude", "codex"]);
const UsageBucketV4 = Schema.Struct({ ...UsageBucket.fields, provider: UsageProviderKindV4 });
const UsageSourceFingerprintV4 = Schema.Struct({
  ...UsageSourceFingerprint.fields,
  provider: UsageProviderKindV4,
});
const UsageSourceV4 = Schema.Struct({
  ...UsageSource.fields,
  fingerprint: UsageSourceFingerprintV4,
});
const UsageSummaryV4 = Schema.Struct({
  ...UsageSummary.fields,
  buckets: Schema.Array(UsageBucketV4),
  sources: Schema.Array(UsageSourceV4),
});
const UsageSummaryInputV4 = Schema.Struct({
  sinceDay: UsageSummaryInput.fields.sinceDay,
  untilDay: UsageSummaryInput.fields.untilDay,
  timeZone: UsageSummaryInput.fields.timeZone,
  resolution: UsageSummaryInput.fields.resolution,
  sinceTime: UsageSummaryInput.fields.sinceTime,
  untilTime: UsageSummaryInput.fields.untilTime,
});

const day = "2026-08-27" as UsageDay;
const summary = Schema.decodeUnknownSync(UsageSummary)({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-08-27T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: day,
  untilDay: day,
  buckets: [
    {
      day,
      provider: "grok",
      model: "grok-code-fast-1",
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 1,
      unpricedRecords: 1,
      sessions: 1,
    },
  ],
  sources: [
    {
      fingerprint: {
        hostId: "host",
        provider: "grok",
        resolvedHomePath: "/home/user/.grok/sessions",
        volumeId: "volume",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: { status: "unavailable", source: "litellm", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 1,
});

describe("usage contract version negotiation", () => {
  it("lets a v5 request pass through a v4 server decoder", () => {
    const decoded = Schema.decodeUnknownSync(UsageSummaryInputV4)({
      supportedContractVersion: USAGE_CONTRACT_VERSION,
      sinceDay: day,
      untilDay: day,
      timeZone: "UTC",
    });

    expect(decoded).toEqual({ sinceDay: day, untilDay: day, timeZone: "UTC" });
  });

  it("projects responses without version negotiation to the v4 wire shape", () => {
    const projected = usageSummaryForClient(summary, undefined);

    expect(projected.contractVersion).toBe(USAGE_MERGE_COMPATIBLE_SINCE);
    expect(projected.buckets).toEqual([]);
    expect(projected.sources).toEqual([]);
    expect(() => Schema.decodeUnknownSync(UsageSummaryV4)(projected)).not.toThrow();
  });

  it("retains v5 providers for clients that advertise v5", () => {
    expect(usageSummaryForClient(summary, USAGE_CONTRACT_VERSION)).toBe(summary);
  });
});
