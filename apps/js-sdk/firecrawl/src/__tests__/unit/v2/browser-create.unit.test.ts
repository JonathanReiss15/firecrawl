import { describe, test, expect, jest } from "@jest/globals";
import { browser } from "../../../v2/methods/browser";

describe("JS SDK v2 browser create", () => {
  test("serializes url when provided", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, id: "sess-1" },
    }));
    const http = { post } as any;

    await browser(http, { url: "https://example.com", ttl: 60 });

    expect(post).toHaveBeenCalledWith("/v2/browser", {
      url: "https://example.com",
      ttl: 60,
    });
  });

  test("omits url when not provided (backward compatible)", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, id: "sess-2" },
    }));
    const http = { post } as any;

    await browser(http, { ttl: 60 });

    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("url");
    expect(body).toEqual({ ttl: 60 });
  });
});
