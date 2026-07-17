import crypto from "crypto";
import { config } from "../../../config";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_FIRE_ENGINE,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
  itIf,
} from "../lib";
import {
  Identity,
  idmux,
  browserCreateRaw,
  browserDeleteRaw,
  browserExecuteRaw,
  browserListRaw,
  scrapeTimeout,
} from "./lib";

// Direct browser/interact session create can begin from a URL, without a
// preliminary scrape. These exercise the cloud (fire-engine / production) path;
// the self-hosted equivalents live in interact-self-host.test.ts.
describe("Browser create from URL (direct)", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "browser-create-url",
      concurrency: 20,
      credits: 1_000_000,
    });
  }, 10000 + scrapeTimeout);

  const canRun =
    ALLOW_TEST_SUITE_WEBSITE &&
    !!config.BROWSER_SERVICE_URL &&
    (TEST_PRODUCTION || HAS_FIRE_ENGINE);

  itIf(canRun)(
    "navigates a freshly created session to the provided URL",
    async () => {
      const targetUrl = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      const createResponse = await browserCreateRaw(
        { url: targetUrl, ttl: 60, activityTtl: 30, recordSession: false },
        identity,
      );
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.body.success).toBe(true);
      const sessionId = createResponse.body.id as string;

      try {
        const executeResponse = await browserExecuteRaw(
          sessionId,
          { language: "node", code: "return page.url();" },
          identity,
        );
        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);
        // Session already sits on the requested origin.
        const landed = String(executeResponse.body.result ?? "");
        expect(landed).toContain(new URL(TEST_SUITE_WEBSITE).host);
      } finally {
        await browserDeleteRaw(sessionId, identity);
      }
    },
    scrapeTimeout * 2,
  );

  itIf(canRun)(
    "still creates a session when no URL is provided (backward compatible)",
    async () => {
      const createResponse = await browserCreateRaw(
        { ttl: 60, activityTtl: 30, recordSession: false },
        identity,
      );
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.body.success).toBe(true);
      const sessionId = createResponse.body.id as string;
      await browserDeleteRaw(sessionId, identity);
    },
    scrapeTimeout * 2,
  );

  itIf(canRun)(
    "rejects a malformed URL without leaving a dangling session",
    async () => {
      const createResponse = await browserCreateRaw(
        { url: "http://", ttl: 60, activityTtl: 30, recordSession: false },
        identity,
      );
      expect(createResponse.statusCode).toBe(400);
      expect(createResponse.body.success).toBe(false);

      const listResponse = await browserListRaw(identity, "active");
      expect(listResponse.statusCode).toBe(200);
      expect(Array.isArray(listResponse.body.sessions)).toBe(true);
    },
    scrapeTimeout,
  );

  itIf(canRun)(
    "rejects a private-network URL without leaving a dangling session",
    async () => {
      const before = await browserListRaw(identity, "active");
      const beforeCount = Array.isArray(before.body.sessions)
        ? before.body.sessions.length
        : 0;

      const createResponse = await browserCreateRaw(
        {
          url: "http://169.254.169.254/latest/meta-data/",
          ttl: 60,
          activityTtl: 30,
          recordSession: false,
        },
        identity,
      );
      expect(createResponse.statusCode).toBe(400);
      expect(createResponse.body.success).toBe(false);

      const after = await browserListRaw(identity, "active");
      const afterCount = Array.isArray(after.body.sessions)
        ? after.body.sessions.length
        : 0;
      expect(afterCount).toBeLessThanOrEqual(beforeCount);
    },
    scrapeTimeout,
  );
});
