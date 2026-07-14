import { describe, expect, it } from "vitest";
import { buildCacheMetadata } from "./cacheMetadata";

describe("buildCacheMetadata", () => {
  it("emits attested cache metadata and legacy hit fields for Firecrawl index hits", () => {
    expect(
      buildCacheMetadata({
        cacheInfo: { created_at: new Date("2026-07-14T12:00:00.000Z") },
        indexWasEligible: true,
      }),
    ).toEqual({
      cache: {
        source: "firecrawl-index",
        cachedAt: "2026-07-14T12:00:00.000Z",
      },
      cacheState: "hit",
      cachedAt: "2026-07-14T12:00:00.000Z",
    });
  });

  it("does not fabricate a miss when index was eligible but no cache hit was attested", () => {
    expect(
      buildCacheMetadata({
        indexWasEligible: true,
        legacyMissEnabled: false,
      }),
    ).toEqual({});
  });

  it("can temporarily emit the deprecated legacy miss behind the bridge flag", () => {
    expect(
      buildCacheMetadata({
        indexWasEligible: true,
        legacyMissEnabled: true,
      }),
    ).toEqual({ cacheState: "miss" });
  });

  it("does not emit miss when index was not eligible", () => {
    expect(
      buildCacheMetadata({
        indexWasEligible: false,
        legacyMissEnabled: true,
      }),
    ).toEqual({});
  });
});
