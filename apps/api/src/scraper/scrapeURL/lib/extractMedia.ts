import { AnyNode, Cheerio, CheerioAPI, load } from "cheerio";

type MediaType = "audio" | "video";
type MediaPresence = "html" | "embed" | "metadata" | "jsonLd" | "text";

type MediaItem = {
  type: MediaType;
  present: true;
  presence: MediaPresence;
  sourceURL: string;
  url?: string;
  title?: string;
  thumbnail?: string;
  description?: string;
  provider?: string;
  mimeType?: string;
  duration?: string;
  count?: number;
};

type MediaBlock = {
  summary: {
    total: number;
    audio: number;
    video: number;
    hasAudio: boolean;
    hasVideo: boolean;
  };
  items: MediaItem[];
};

type ExtractMediaOptions = {
  types?: MediaType[];
  limit?: number;
};

const DEFAULT_MEDIA_TYPES: MediaType[] = ["video", "audio"];
const DEFAULT_LIMIT = 25;

function normalizeWhitespace(
  value: string | undefined | null,
): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function resolveUrl(
  value: string | undefined | null,
  baseUrl: string,
  baseHref = "",
): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const lowered = raw.toLowerCase();
  if (
    lowered.startsWith("javascript:") ||
    lowered.startsWith("mailto:") ||
    lowered.startsWith("tel:") ||
    lowered.startsWith("blob:") ||
    lowered.startsWith("data:") ||
    lowered.startsWith("#")
  ) {
    return undefined;
  }

  let resolutionBase = baseUrl;
  if (baseHref) {
    try {
      resolutionBase = new URL(baseHref, baseUrl).href;
    } catch {
      resolutionBase = baseUrl;
    }
  }

  try {
    return new URL(raw, resolutionBase).href;
  } catch {
    return undefined;
  }
}

function getMetaContent(
  $: CheerioAPI,
  selectors: string[],
): string | undefined {
  for (const selector of selectors) {
    const content = normalizeWhitespace($(selector).first().attr("content"));
    if (content) return content;
  }
  return undefined;
}

function getPageTitle($: CheerioAPI): string | undefined {
  return (
    getMetaContent($, [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[name="title"]',
    ]) ?? normalizeWhitespace($("title").first().text())
  );
}

function getFallbackThumbnail(
  $: CheerioAPI,
  baseUrl: string,
  baseHref: string,
): string | undefined {
  return resolveUrl(
    getMetaContent($, [
      'meta[property="og:image"]',
      'meta[property="og:image:url"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'meta[itemprop="image"]',
    ]),
    baseUrl,
    baseHref,
  );
}

function providerFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be" || host.endsWith("youtube.com")) return "youtube";
    if (host.endsWith("vimeo.com")) return "vimeo";
    if (host.endsWith("wistia.com") || host.endsWith("wistia.net")) {
      return "wistia";
    }
    if (host.endsWith("brightcove.net") || host.endsWith("brightcove.com")) {
      return "brightcove";
    }
    if (host.endsWith("vidyard.com")) return "vidyard";
    if (host.endsWith("dailymotion.com")) return "dailymotion";
    if (host.endsWith("tiktok.com")) return "tiktok";
    if (host.endsWith("soundcloud.com")) return "soundcloud";
    if (host.endsWith("spotify.com")) return "spotify";
    if (host.endsWith("podcasts.apple.com")) return "apple-podcasts";
    return host;
  } catch {
    return undefined;
  }
}

function inferMediaType(
  value: string | undefined,
  mimeType?: string,
): MediaType | undefined {
  const mime = mimeType?.toLowerCase();
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";

  const lowered = value?.toLowerCase() ?? "";
  if (
    /\.(mp4|m4v|webm|mov|avi|mkv|m3u8)([?#].*)?$/.test(lowered) ||
    lowered.includes("youtube.com/watch") ||
    lowered.includes("youtube.com/embed") ||
    lowered.includes("youtu.be/") ||
    lowered.includes("vimeo.com/") ||
    lowered.includes("wistia.") ||
    lowered.includes("brightcove") ||
    lowered.includes("vidyard") ||
    lowered.includes("dailymotion.com") ||
    lowered.includes("tiktok.com/embed")
  ) {
    return "video";
  }

  if (
    /\.(mp3|m4a|wav|ogg|oga|aac|flac)([?#].*)?$/.test(lowered) ||
    lowered.includes("soundcloud.com/") ||
    lowered.includes("spotify.com/embed") ||
    lowered.includes("podcasts.apple.com/")
  ) {
    return "audio";
  }

  return undefined;
}

function getElementTitle(
  $: CheerioAPI,
  element: Cheerio<AnyNode>,
  fallbackTitle: string | undefined,
): string | undefined {
  return (
    normalizeWhitespace(element.attr("title")) ??
    normalizeWhitespace(element.attr("aria-label")) ??
    normalizeWhitespace(element.attr("data-title")) ??
    normalizeWhitespace(
      element.closest("figure").find("figcaption").first().text(),
    ) ??
    fallbackTitle
  );
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeWhitespace(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return (
      firstString(objectValue.url) ??
      firstString(objectValue.contentUrl) ??
      firstString(objectValue.embedUrl) ??
      firstString(objectValue["@id"])
    );
  }
  return undefined;
}

function schemaTypes(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(schemaTypes);
  return [];
}

function visitJsonLd(
  value: unknown,
  visitor: (node: Record<string, unknown>) => void,
) {
  if (Array.isArray(value)) {
    value.forEach(item => visitJsonLd(item, visitor));
    return;
  }

  if (!value || typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  visitor(node);

  for (const nested of Object.values(node)) {
    if (nested && typeof nested === "object") {
      visitJsonLd(nested, visitor);
    }
  }
}

function parseJsonLd(scriptText: string): unknown | undefined {
  const trimmed = scriptText.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function buildSummary(items: MediaItem[]): MediaBlock["summary"] {
  const summary = {
    total: 0,
    audio: 0,
    video: 0,
    hasAudio: false,
    hasVideo: false,
  };

  for (const item of items) {
    const count = Math.max(1, item.count ?? 1);
    summary.total += count;
    summary[item.type] += count;
  }

  summary.hasAudio = summary.audio > 0;
  summary.hasVideo = summary.video > 0;
  return summary;
}

export async function extractMedia(
  html: string,
  baseUrl: string,
  options: ExtractMediaOptions = {},
): Promise<MediaBlock> {
  const $ = load(html);
  const baseHref = $("base[href]").first().attr("href") || "";
  const requestedTypes = new Set(options.types ?? DEFAULT_MEDIA_TYPES);
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 100));
  const pageTitle = getPageTitle($);
  const fallbackThumbnail = getFallbackThumbnail($, baseUrl, baseHref);
  const itemsByKey = new Map<string, MediaItem>();

  function addMedia(item: Omit<MediaItem, "present" | "sourceURL">) {
    if (!requestedTypes.has(item.type)) return;

    const normalized: MediaItem = {
      ...item,
      present: true,
      sourceURL: baseUrl,
      title: normalizeWhitespace(item.title),
      thumbnail: resolveUrl(item.thumbnail, baseUrl, baseHref),
      url: resolveUrl(item.url, baseUrl, baseHref),
      description: normalizeWhitespace(item.description),
      provider: item.provider ?? providerFromUrl(item.url),
      mimeType: normalizeWhitespace(item.mimeType),
      duration: normalizeWhitespace(item.duration),
      count: item.count && item.count > 1 ? item.count : undefined,
    };

    if (
      !normalized.url &&
      !normalized.title &&
      !normalized.thumbnail &&
      !normalized.count
    ) {
      return;
    }

    const key = [
      normalized.type,
      normalized.url ?? "",
      normalized.presence,
      normalized.title ?? "",
      normalized.thumbnail ?? "",
    ].join("|");
    const existing = itemsByKey.get(key);
    if (existing) {
      itemsByKey.set(key, {
        ...existing,
        ...Object.fromEntries(
          Object.entries(normalized).filter(([, value]) => value !== undefined),
        ),
        count: Math.max(existing.count ?? 1, normalized.count ?? 1),
      });
      return;
    }

    itemsByKey.set(key, normalized);
  }

  $("video").each((_, element) => {
    const video = $(element);
    const title = getElementTitle($, video, pageTitle);
    const thumbnail =
      resolveUrl(video.attr("poster"), baseUrl, baseHref) ?? fallbackThumbnail;
    const directSrc = video.attr("src");
    const sources = directSrc
      ? [{ url: directSrc, mimeType: video.attr("type") }]
      : video
          .find("source[src]")
          .map((__, source) => ({
            url: $(source).attr("src"),
            mimeType: $(source).attr("type"),
          }))
          .get();

    if (sources.length === 0) {
      addMedia({
        type: "video",
        presence: "html",
        title,
        thumbnail,
      });
      return;
    }

    for (const source of sources) {
      addMedia({
        type: "video",
        presence: "html",
        url: source.url,
        title,
        thumbnail,
        mimeType: source.mimeType,
      });
    }
  });

  $("audio").each((_, element) => {
    const audio = $(element);
    const title = getElementTitle($, audio, pageTitle);
    const directSrc = audio.attr("src");
    const sources = directSrc
      ? [{ url: directSrc, mimeType: audio.attr("type") }]
      : audio
          .find("source[src]")
          .map((__, source) => ({
            url: $(source).attr("src"),
            mimeType: $(source).attr("type"),
          }))
          .get();

    if (sources.length === 0) {
      addMedia({
        type: "audio",
        presence: "html",
        title,
      });
      return;
    }

    for (const source of sources) {
      addMedia({
        type: "audio",
        presence: "html",
        url: source.url,
        title,
        mimeType: source.mimeType,
      });
    }
  });

  $("iframe[src], embed[src], object[data]").each((_, element) => {
    const embedded = $(element);
    const url = embedded.attr("src") ?? embedded.attr("data");
    const type = inferMediaType(url, embedded.attr("type"));
    if (!type) return;

    addMedia({
      type,
      presence: "embed",
      url,
      title: getElementTitle($, embedded, pageTitle),
      thumbnail: fallbackThumbnail,
      mimeType: embedded.attr("type"),
      provider: providerFromUrl(url),
    });
  });

  $("a[href]").each((_, element) => {
    const link = $(element);
    const url = link.attr("href");
    const type = inferMediaType(url, link.attr("type"));
    if (!type) return;

    addMedia({
      type,
      presence: "embed",
      url,
      title:
        normalizeWhitespace(link.attr("title")) ??
        normalizeWhitespace(link.text()) ??
        pageTitle,
      thumbnail: fallbackThumbnail,
      mimeType: link.attr("type"),
      provider: providerFromUrl(url),
    });
  });

  const metadataVideoUrls = [
    'meta[property="og:video"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video:secure_url"]',
    'meta[name="twitter:player"]',
    'meta[name="twitter:player:stream"]',
  ];
  for (const selector of metadataVideoUrls) {
    const url = getMetaContent($, [selector]);
    if (!url) continue;
    addMedia({
      type: "video",
      presence: "metadata",
      url,
      title: pageTitle,
      thumbnail: fallbackThumbnail,
      mimeType: getMetaContent($, ['meta[property="og:video:type"]']),
      provider: providerFromUrl(url),
    });
  }

  const metadataAudioUrls = [
    'meta[property="og:audio"]',
    'meta[property="og:audio:url"]',
    'meta[property="og:audio:secure_url"]',
  ];
  for (const selector of metadataAudioUrls) {
    const url = getMetaContent($, [selector]);
    if (!url) continue;
    addMedia({
      type: "audio",
      presence: "metadata",
      url,
      title: pageTitle,
      thumbnail: fallbackThumbnail,
      mimeType: getMetaContent($, ['meta[property="og:audio:type"]']),
      provider: providerFromUrl(url),
    });
  }

  $('script[type="application/ld+json"]').each((_, element) => {
    const parsed = parseJsonLd($(element).text());
    if (!parsed) return;

    visitJsonLd(parsed, node => {
      const types = schemaTypes(node["@type"]).map(type => type.toLowerCase());
      const isVideo = types.includes("videoobject");
      const isAudio = types.includes("audioobject");
      if (!isVideo && !isAudio) return;

      const url =
        firstString(node.contentUrl) ??
        firstString(node.embedUrl) ??
        firstString(node.url);
      const thumbnail =
        firstString(node.thumbnailUrl) ?? firstString(node.thumbnail);
      const mimeType =
        firstString(node.encodingFormat) ?? firstString(node.mimeType);
      const duration = firstString(node.duration);

      addMedia({
        type: isVideo ? "video" : "audio",
        presence: "jsonLd",
        url,
        title:
          firstString(node.name) ??
          firstString(node.headline) ??
          firstString(node.title) ??
          pageTitle,
        thumbnail: thumbnail ?? fallbackThumbnail,
        description: firstString(node.description),
        mimeType,
        duration,
        provider: providerFromUrl(url),
      });
    });
  });

  const currentItems = () => Array.from(itemsByKey.values());
  const bodyText = normalizeWhitespace($("body").text()) ?? "";

  if (!currentItems().some(item => item.type === "video")) {
    const match = bodyText.match(/\b(\d{1,3})\s+videos?\b/i);
    if (match) {
      addMedia({
        type: "video",
        presence: "text",
        title: pageTitle,
        thumbnail: fallbackThumbnail,
        count: Number(match[1]),
      });
    }
  }

  if (!currentItems().some(item => item.type === "audio")) {
    const match = bodyText.match(
      /\b(\d{1,3})\s+(?:audio|podcasts?|tracks?)\b/i,
    );
    if (match) {
      addMedia({
        type: "audio",
        presence: "text",
        title: pageTitle,
        thumbnail: fallbackThumbnail,
        count: Number(match[1]),
      });
    }
  }

  const items = currentItems().slice(0, limit);
  return {
    summary: buildSummary(items),
    items,
  };
}
