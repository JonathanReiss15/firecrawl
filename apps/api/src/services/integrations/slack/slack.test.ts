import crypto from "crypto";
import { describe, it, expect, afterEach } from "vitest";
import { config } from "../../../config";
import { encryptSlackToken, decryptSlackToken } from "./crypto";
import { verifySlackSignature } from "./signature";
import { buildMonitorAlertMessage, escapeSlackText } from "./messages";

const ORIGINAL_ENCRYPTION_KEY = config.SLACK_TOKEN_ENCRYPTION_KEY;
const ORIGINAL_SIGNING_SECRET = config.SLACK_SIGNING_SECRET;

afterEach(() => {
  config.SLACK_TOKEN_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  config.SLACK_SIGNING_SECRET = ORIGINAL_SIGNING_SECRET;
});

describe("slack token crypto", () => {
  it("round-trips a token with AES-256-GCM when a key is configured", () => {
    config.SLACK_TOKEN_ENCRYPTION_KEY = crypto
      .randomBytes(32)
      .toString("hex");
    const token = "xoxb-1234567890-abcdefghijklmnop";
    const stored = encryptSlackToken(token);
    expect(stored.startsWith("gcm:")).toBe(true);
    expect(stored).not.toContain(token);
    expect(decryptSlackToken(stored)).toBe(token);
  });

  it("falls back to a plaintext marker when no key is set", () => {
    config.SLACK_TOKEN_ENCRYPTION_KEY = undefined;
    const token = "xoxb-selfhosted";
    const stored = encryptSlackToken(token);
    expect(stored).toBe(`plain:${token}`);
    expect(decryptSlackToken(stored)).toBe(token);
  });

  it("throws when a GCM token is read without its key", () => {
    config.SLACK_TOKEN_ENCRYPTION_KEY = crypto
      .randomBytes(32)
      .toString("hex");
    const stored = encryptSlackToken("xoxb-secret");
    config.SLACK_TOKEN_ENCRYPTION_KEY = undefined;
    expect(() => decryptSlackToken(stored)).toThrow();
  });
});

describe("slack signature verification", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";

  function sign(body: string, timestamp: string): string {
    return (
      "v0=" +
      crypto
        .createHmac("sha256", secret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")
    );
  }

  it("accepts a correctly signed, fresh request", () => {
    const body = "token=abc&command=%2Fmonitor&text=list";
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(
      verifySlackSignature({
        signature: sign(body, timestamp),
        timestamp,
        rawBody: body,
        signingSecret: secret,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign("original", timestamp);
    expect(
      verifySlackSignature({
        signature,
        timestamp,
        rawBody: "tampered",
        signingSecret: secret,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", () => {
    const body = "text=list";
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 10);
    expect(
      verifySlackSignature({
        signature: sign(body, staleTs),
        timestamp: staleTs,
        rawBody: body,
        signingSecret: secret,
      }),
    ).toBe(false);
  });

  it("rejects when no signing secret is available", () => {
    config.SLACK_SIGNING_SECRET = undefined;
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(
      verifySlackSignature({
        signature: "v0=deadbeef",
        timestamp,
        rawBody: "x",
      }),
    ).toBe(false);
  });
});

describe("slack message builder", () => {
  it("escapes Slack mrkdwn control characters", () => {
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("builds an alert with a header, summary, page rows and a dashboard button", () => {
    const { text, blocks } = buildMonitorAlertMessage({
      monitorName: "Pricing <watch>",
      dashboardUrl: "https://www.firecrawl.dev/app/monitoring/m1?checkId=c1",
      checkId: "c1",
      summary: { changed: 2, new: 1, removed: 0, error: 0, totalPages: 5 },
      pages: [
        {
          url: "https://example.com/pricing",
          status: "changed",
          judgment: { meaningful: true, reason: "Price changed" },
        },
      ],
      creditsUsed: 7,
    });

    expect(text).toContain("Pricing <watch>");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("header");
    expect(serialized).toContain("View in dashboard");
    expect(serialized).toContain("example.com/pricing");
    // Header text is plain_text; the monitor name is not escaped there but the
    // fallback text keeps it readable.
    expect(serialized).toContain("meaningful");
  });
});
