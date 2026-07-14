export type CacheInfo = {
  created_at: Date;
};

export type AttestedCacheMetadata = {
  cache: {
    source: "firecrawl-index";
    cachedAt: string;
  };
  cacheState: "hit";
  cachedAt: string;
};

export type LegacyMissCacheMetadata = {
  cacheState: "miss";
};

export type CacheMetadata =
  AttestedCacheMetadata | LegacyMissCacheMetadata | Record<string, never>;

export function buildCacheMetadata({
  cacheInfo,
  indexWasEligible,
  legacyMissEnabled = false,
}: {
  cacheInfo?: CacheInfo;
  indexWasEligible: boolean;
  legacyMissEnabled?: boolean;
}): CacheMetadata {
  if (cacheInfo) {
    const cachedAt = cacheInfo.created_at.toISOString();

    return {
      cache: {
        source: "firecrawl-index",
        cachedAt,
      },
      cacheState: "hit",
      cachedAt,
    };
  }

  if (indexWasEligible && legacyMissEnabled) {
    return { cacheState: "miss" };
  }

  return {};
}
