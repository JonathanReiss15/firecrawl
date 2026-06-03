import { extractMedia } from "../extractMedia";

describe("extractMedia", () => {
  const baseUrl = "https://example.com/products/phone";

  it("extracts native video and audio sources with titles and thumbnails", async () => {
    const media = await extractMedia(
      `
        <html>
          <head><title>Product page</title></head>
          <body>
            <figure>
              <video poster="/thumbs/demo.jpg" title="Product demo">
                <source src="/media/demo.mp4" type="video/mp4">
              </video>
              <figcaption>Phone demo video</figcaption>
            </figure>
            <audio aria-label="Launch podcast">
              <source src="https://cdn.example.com/podcast.mp3" type="audio/mpeg">
            </audio>
          </body>
        </html>
      `,
      baseUrl,
    );

    expect(media.summary).toEqual({
      total: 2,
      audio: 1,
      video: 1,
      hasAudio: true,
      hasVideo: true,
    });
    expect(media.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "video",
          presence: "html",
          present: true,
          sourceURL: baseUrl,
          url: "https://example.com/media/demo.mp4",
          title: "Product demo",
          thumbnail: "https://example.com/thumbs/demo.jpg",
          mimeType: "video/mp4",
        }),
        expect.objectContaining({
          type: "audio",
          presence: "html",
          present: true,
          sourceURL: baseUrl,
          url: "https://cdn.example.com/podcast.mp3",
          title: "Launch podcast",
          mimeType: "audio/mpeg",
        }),
      ]),
    );
  });

  it("extracts metadata and JSON-LD media", async () => {
    const media = await extractMedia(
      `
        <html>
          <head>
            <meta property="og:title" content="Metadata title">
            <meta property="og:image" content="/og.jpg">
            <meta property="og:video:secure_url" content="https://videos.example.com/demo.webm">
            <meta property="og:video:type" content="video/webm">
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "AudioObject",
                "name": "Narrated review",
                "contentUrl": "/audio/review.m4a",
                "encodingFormat": "audio/mp4",
                "duration": "PT3M"
              }
            </script>
          </head>
        </html>
      `,
      baseUrl,
    );

    expect(media.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "video",
          presence: "metadata",
          url: "https://videos.example.com/demo.webm",
          title: "Metadata title",
          thumbnail: "https://example.com/og.jpg",
          mimeType: "video/webm",
        }),
        expect.objectContaining({
          type: "audio",
          presence: "jsonLd",
          url: "https://example.com/audio/review.m4a",
          title: "Narrated review",
          mimeType: "audio/mp4",
          duration: "PT3M",
        }),
      ]),
    );
  });

  it("extracts embed links and filters requested media types", async () => {
    const media = await extractMedia(
      `
        <html>
          <head><title>Media embeds</title></head>
          <body>
            <iframe src="https://www.youtube.com/embed/abc123" title="Video embed"></iframe>
            <a href="https://soundcloud.com/example/episode">Listen</a>
          </body>
        </html>
      `,
      baseUrl,
      { types: ["video"] },
    );

    expect(media.summary).toEqual({
      total: 1,
      audio: 0,
      video: 1,
      hasAudio: false,
      hasVideo: true,
    });
    expect(media.items).toHaveLength(1);
    expect(media.items[0]).toEqual(
      expect.objectContaining({
        type: "video",
        presence: "embed",
        url: "https://www.youtube.com/embed/abc123",
        provider: "youtube",
        title: "Video embed",
      }),
    );
  });

  it("records text-only presence counts when URLs are absent", async () => {
    const media = await extractMedia(
      `
        <html>
          <head>
            <title>Apple - iPhone 17 256GB - Black (Verizon)</title>
            <meta property="og:image" content="/product.jpg">
          </head>
          <body>
            <button>2 Videos</button>
          </body>
        </html>
      `,
      baseUrl,
    );

    expect(media.summary.video).toBe(2);
    expect(media.summary.total).toBe(2);
    expect(media.items).toEqual([
      expect.objectContaining({
        type: "video",
        presence: "text",
        count: 2,
        title: "Apple - iPhone 17 256GB - Black (Verizon)",
        thumbnail: "https://example.com/product.jpg",
      }),
    ]);
  });
});
