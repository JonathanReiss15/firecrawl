import { afterEach, describe, expect, it, vi } from "vitest";

describe("OAuth cache invalidation configuration", () => {
  const original = process.env.OAUTH_CACHE_INVALIDATION_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.OAUTH_CACHE_INVALIDATION_ENABLED;
    } else {
      process.env.OAUTH_CACHE_INVALIDATION_ENABLED = original;
    }
    vi.resetModules();
  });

  it("is disabled by default", async () => {
    delete process.env.OAUTH_CACHE_INVALIDATION_ENABLED;
    vi.resetModules();
    const { config } = await import("../config.js");
    expect(config.OAUTH_CACHE_INVALIDATION_ENABLED).toBe(false);
  });
});
