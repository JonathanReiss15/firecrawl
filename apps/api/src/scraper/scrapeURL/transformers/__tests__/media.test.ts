jest.mock("../../../../services/index", () => ({
  useIndex: false,
  useSearchIndex: false,
}));

jest.mock("../../../../services/indexing/indexer-queue", () => ({
  indexerQueue: { sendToWorker: jest.fn() },
}));

jest.mock("../llmExtract", () => ({
  performLLMExtract: (_meta: unknown, document: unknown) => document,
  performSummary: (_meta: unknown, document: unknown) => document,
  performCleanContent: (_meta: unknown, document: unknown) => document,
}));

jest.mock("../query", () => ({
  performQuery: (_meta: unknown, document: unknown) => document,
}));

jest.mock("../agent", () => ({
  performAgent: (_meta: unknown, document: unknown) => document,
}));

jest.mock("../performAttributes", () => ({
  performAttributes: (_meta: unknown, document: unknown) => document,
}));

jest.mock("../diff", () => ({
  deriveDiff: (_meta: unknown, document: unknown) => document,
}));

jest.mock("../audio", () => ({
  fetchAudio: (_meta: unknown, document: unknown) => document,
}));

jest.mock("../video", () => ({
  fetchVideo: (_meta: unknown, document: unknown) => document,
}));

import { coerceFieldsToFormats } from "../index";

describe("coerceFieldsToFormats media", () => {
  const media = {
    summary: {
      total: 1,
      audio: 0,
      video: 1,
      hasAudio: false,
      hasVideo: true,
    },
    items: [
      {
        type: "video",
        present: true,
        presence: "metadata",
        sourceURL: "https://example.com",
        url: "https://cdn.example.com/video.mp4",
      },
    ],
  };

  function meta(formats: any[]) {
    return {
      options: { formats },
      internalOptions: {},
      logger: {
        warn: jest.fn(),
        debug: jest.fn(),
      },
    } as any;
  }

  it("keeps media only when the media format is requested", () => {
    const document = { metadata: {}, media: structuredClone(media) } as any;

    const result = coerceFieldsToFormats(
      meta([{ type: "media", types: ["video"], limit: 10 }]),
      document,
    );

    expect(result.media).toEqual(media);
  });

  it("removes media when the media format is not requested", () => {
    const document = { metadata: {}, media: structuredClone(media) } as any;

    const result = coerceFieldsToFormats(
      meta([{ type: "markdown" }]),
      document,
    );

    expect(result.media).toBeUndefined();
  });
});
