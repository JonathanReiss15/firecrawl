import { config } from "../../config";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { logger } from "../logger";
import type { RawVerdict, ThreatProtectionMode } from "./types";

// Provider verdicts are cached in Redis, keyed by (domain, mode) — the two
// modes use different providers so their verdicts never mix. TTL is modest
// (THREAT_PROTECTION_CACHE_TTL_SECONDS, default 6h) because verdict freshness
// is an acceptance criterion for the feature. All cache errors degrade to a
// miss / no-op: the cache only ever saves provider calls, never breaks them.

const cacheKey = (domain: string, mode: ThreatProtectionMode) =>
  `threat_protection_verdict:${mode}:${domain}`;

export async function getCachedVerdict(
  domain: string,
  mode: ThreatProtectionMode,
): Promise<RawVerdict | null> {
  try {
    const raw = await redisRateLimitClient.get(cacheKey(domain, mode));
    if (!raw) return null;
    const verdict = JSON.parse(raw) as RawVerdict;
    return { ...verdict, fromCache: true };
  } catch (error) {
    logger.warn("Failed to read threat protection verdict from cache", {
      canonicalLog: "threat-protection/cache",
      domain,
      mode,
      error,
    });
    return null;
  }
}

export async function setCachedVerdict(
  domain: string,
  mode: ThreatProtectionMode,
  verdict: RawVerdict,
): Promise<void> {
  try {
    await redisRateLimitClient.set(
      cacheKey(domain, mode),
      JSON.stringify({ ...verdict, fromCache: false }),
      "EX",
      config.THREAT_PROTECTION_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    // Best-effort: a failed write just means we look the domain up again.
    logger.warn("Failed to cache threat protection verdict", {
      canonicalLog: "threat-protection/cache",
      domain,
      mode,
      error,
    });
  }
}
