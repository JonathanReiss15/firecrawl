import { fetchVideo, resetVideoTransformerCacheForTests } from "../video";
import { config } from "../../../../config";

describe("fetchVideo", () => {
  const originalFetch = global.fetch;
  const originalAvgrabServiceUrl = config.AVGRAB_SERVICE_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    config.AVGRAB_SERVICE_URL = originalAvgrabServiceUrl;
    resetVideoTransformerCacheForTests();
    jest.clearAllMocks();
  });

  function mockSuccessfulAvgrab() {
    const fetchSpy = jest.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/supported-urls")) {
        return {
          ok: true,
          json: async () => ({ regex: "https://example\\.com/video" }),
        };
      }

      return {
        ok: true,
        json: async () => ({ public_url: "https://storage.example/video.mp4" }),
      };
    });

    global.fetch = fetchSpy as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";
    return fetchSpy;
  }

  it("returns generic videos without downloading or requiring a supported provider URL", async () => {
    const video = {
      url: "https://cdn.example.com/product.mp4",
      sourceURL: "https://example.com/product",
      source: "metadata",
      kind: "file",
      provider: "example.com",
      title: "Product clip",
      thumbnail: "https://cdn.example.com/poster.jpg",
      mimeType: "video/mp4",
    };
    const fetchSpy = jest.fn(async (url: string) => {
      if (url.endsWith("/videos")) {
        return {
          ok: true,
          json: async () => ({ videos: [video] }),
        };
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    global.fetch = fetchSpy as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";

    const meta: any = {
      url: "https://example.com/product",
      options: {
        lockdown: false,
        formats: [{ type: "video" }],
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    };
    const document: any = { rawHtml: "<html></html>" };

    await fetchVideo(meta, document);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://avgrab.example/videos",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/product",
          html: "<html></html>",
        }),
      }),
    );
    expect(document.videos).toEqual([video]);
    expect(document.video).toBeUndefined();
  });

  it("does not issue any fetch when lockdown is true, even if video format is requested", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const meta: any = {
      url: "https://example.com/video",
      options: {
        lockdown: true,
        formats: [{ type: "video" }],
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    };
    const document: any = { markdown: "cached" };

    const result = await fetchVideo(meta, document);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toBe(document);
    expect(result.video).toBeUndefined();
  });

  it("returns early when video format is not requested regardless of lockdown", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const meta: any = {
      url: "https://example.com/video",
      options: {
        lockdown: false,
        formats: [{ type: "markdown" }],
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    };
    const document: any = { markdown: "cached" };

    await fetchVideo(meta, document);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a warning when avgrab is not configured", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    config.AVGRAB_SERVICE_URL = undefined;

    const meta: any = {
      url: "https://example.com/video",
      options: {
        lockdown: false,
        formats: [{ type: "video" }],
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    };
    const document: any = {};

    const result = await fetchVideo(meta, document);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(meta.logger.warn).toHaveBeenCalledWith(
      "AVGRAB_SERVICE_URL is not configured",
    );
    expect(result.warning).toMatch(/Video format is not available/);
  });

  it("forwards browser cookies to avgrab when video cookies are available", async () => {
    const fetchSpy = mockSuccessfulAvgrab();
    const cookies = [
      {
        name: "VISITOR_INFO1_LIVE",
        value: "visitor",
        domain: ".youtube.com",
        path: "/",
        secure: true,
        httpOnly: true,
      },
    ];

    const meta: any = {
      url: "https://example.com/video",
      audioCookies: cookies,
      options: {
        lockdown: false,
        formats: [{ type: "video" }],
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    };
    const document: any = {};

    await fetchVideo(meta, document);

    const downloadCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).endsWith("/download-video"),
    );
    expect(downloadCall).toBeDefined();
    const body = downloadCall![1]?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({
      url: "https://example.com/video",
      cookies,
    });
    expect(document.video).toBe("https://storage.example/video.mp4");
  });

  it("keeps generic provider entries and still populates legacy video for supported provider URLs", async () => {
    const providerVideo = {
      url: "https://www.youtube.com/watch?v=abc123",
      sourceURL: "https://www.youtube.com/watch?v=abc123",
      source: "provider",
      kind: "page",
      provider: "youtube",
      title: "Video page",
    };
    const fetchSpy = jest.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/videos")) {
        return {
          ok: true,
          json: async () => ({ videos: [providerVideo] }),
        };
      }
      if (url.endsWith("/supported-urls")) {
        return {
          ok: true,
          json: async () => ({ regex: "https://www\\.youtube\\.com/watch" }),
        };
      }

      return {
        ok: true,
        json: async () => ({ public_url: "https://storage.example/video.mp4" }),
      };
    });
    global.fetch = fetchSpy as any;
    config.AVGRAB_SERVICE_URL = "https://avgrab.example";

    const meta: any = {
      url: "https://www.youtube.com/watch?v=abc123",
      options: {
        lockdown: false,
        formats: [{ type: "video" }],
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    };
    const document: any = {};

    await fetchVideo(meta, document);

    expect(document.videos).toEqual([providerVideo]);
    expect(document.video).toBe("https://storage.example/video.mp4");
  });

  it("omits cookies from the avgrab request when no video cookies are available", async () => {
    const fetchSpy = mockSuccessfulAvgrab();

    const meta: any = {
      url: "https://example.com/video",
      options: {
        lockdown: false,
        formats: [{ type: "video" }],
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    };
    const document: any = {};

    await fetchVideo(meta, document);

    const downloadCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).endsWith("/download-video"),
    );
    expect(downloadCall).toBeDefined();
    const body = downloadCall![1]?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({
      url: "https://example.com/video",
    });
  });

  it("leaves video fields empty when no generic videos are found and the URL is not supported by legacy download", async () => {
    mockSuccessfulAvgrab();

    const meta: any = {
      url: "https://example.com/unsupported",
      options: {
        lockdown: false,
        formats: [{ type: "video" }],
      },
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    };
    const document: any = {};

    await expect(fetchVideo(meta, document)).resolves.toBe(document);
    expect(document.video).toBeUndefined();
    expect(document.videos).toBeUndefined();
  });
});
