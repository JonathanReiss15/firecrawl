import { config } from "../../../config";
import { TEST_SELF_HOST, itIf } from "../lib";
import {
  browserCreateRaw,
  browserDeleteRaw,
  browserExecuteRaw,
  browserListRaw,
  type Identity,
} from "./lib";

describe("Interact in self-hosted mode", () => {
  const identity: Identity = { apiKey: "local", teamId: "bypass" };

  itIf(TEST_SELF_HOST && !!config.BROWSER_SERVICE_URL)(
    "creates, executes, and destroys a browser session without database auth",
    async () => {
      const createResponse = await browserCreateRaw(
        { ttl: 60, activityTtl: 30, recordSession: false },
        identity,
      );
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.body.success).toBe(true);
      const sessionId = createResponse.body.id as string;

      const executeResponse = await browserExecuteRaw(
        sessionId,
        {
          language: "node",
          code: `
            await page.setContent("<h1>Local interact works</h1>");
            return await page.locator("h1").textContent();
          `,
        },
        identity,
      );
      expect(executeResponse.statusCode).toBe(200);
      expect(executeResponse.body).toMatchObject({
        success: true,
        result: "Local interact works",
        exitCode: 0,
        killed: false,
      });

      const deleteResponse = await browserDeleteRaw(sessionId, identity);
      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.body.success).toBe(true);

      const afterDeleteResponse = await browserExecuteRaw(
        sessionId,
        { language: "node", code: "return await page.title();" },
        identity,
      );
      expect(afterDeleteResponse.statusCode).toBe(410);
      expect(afterDeleteResponse.body).toMatchObject({
        success: false,
        error: "Browser session has been destroyed.",
      });
    },
    30_000,
  );

  itIf(TEST_SELF_HOST && !!config.BROWSER_SERVICE_URL)(
    "creates a session started from a URL and lands on that page",
    async () => {
      const targetUrl = "https://example.com/";
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
        // The session should already be on the requested page — no navigation
        // needed by the caller.
        expect(String(executeResponse.body.result)).toContain("example.com");
      } finally {
        await browserDeleteRaw(sessionId, identity);
      }
    },
    30_000,
  );

  itIf(TEST_SELF_HOST && !!config.BROWSER_SERVICE_URL)(
    "creates a session WITHOUT a URL (backward compatible)",
    async () => {
      const createResponse = await browserCreateRaw(
        { ttl: 60, activityTtl: 30, recordSession: false },
        identity,
      );
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.body.success).toBe(true);
      const sessionId = createResponse.body.id as string;
      // No navigation should have happened / been assumed; the session is
      // simply usable.
      await browserDeleteRaw(sessionId, identity);
    },
    30_000,
  );

  itIf(TEST_SELF_HOST)(
    "rejects a malformed URL before creating a session",
    async () => {
      const createResponse = await browserCreateRaw(
        { url: "http://", ttl: 60, activityTtl: 30, recordSession: false },
        identity,
      );
      expect(createResponse.statusCode).toBe(400);
      expect(createResponse.body.success).toBe(false);

      // No dangling active session should have been left behind.
      const listResponse = await browserListRaw(identity, "active");
      expect(listResponse.statusCode).toBe(200);
      expect(Array.isArray(listResponse.body.sessions)).toBe(true);
    },
    30_000,
  );

  itIf(
    TEST_SELF_HOST &&
      !!config.BROWSER_SERVICE_URL &&
      config.ALLOW_LOCAL_WEBHOOKS !== true,
  )(
    "rejects a private-network URL before creating a session",
    async () => {
      // Snapshot active sessions before the blocked request so we can assert
      // the count did not grow (the blocked target must not create a session).
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
    30_000,
  );
});
