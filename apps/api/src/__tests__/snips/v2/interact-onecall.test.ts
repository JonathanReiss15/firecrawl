import crypto from "crypto";
import { config } from "../../../config";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_AI,
  HAS_FIRE_ENGINE,
  TEST_PRODUCTION,
  TEST_SELF_HOST,
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

// One-call interact: create a session, optionally navigate to a `url`, and run
// an initial `prompt` OR `code` — all in a single request — returning the same
// retained session plus the same execution semantics as create-then-execute.
describe("Interact one-call (create + navigate + execute)", () => {
  let identity: Identity;

  beforeAll(async () => {
    if (TEST_SELF_HOST) {
      // Self-hosted mode runs without database auth.
      identity = { apiKey: "local", teamId: "bypass" };
    } else {
      identity = await idmux({
        name: "interact-onecall",
        concurrency: 20,
        credits: 1_000_000,
      });
    }
  }, 10000 + scrapeTimeout);

  // A browser service is required for anything that actually creates a session.
  const canRunBrowser =
    ALLOW_TEST_SUITE_WEBSITE &&
    !!config.BROWSER_SERVICE_URL &&
    (TEST_PRODUCTION || HAS_FIRE_ENGINE);

  // The prompt path additionally needs a model.
  const canRunPrompt = canRunBrowser && (TEST_PRODUCTION || HAS_AI);

  // ---------------------------------------------------------------------------
  // Validation failures (no browser service needed — schema rejects first).
  // ---------------------------------------------------------------------------

  it("returns 400 when both 'prompt' and 'code' are provided, executing neither", async () => {
    const response = await browserCreateRaw(
      {
        code: "return page.url();",
        prompt: "Report the current page title",
        ttl: 60,
        activityTtl: 30,
        recordSession: false,
      },
      identity,
    );
    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(JSON.stringify(response.body)).toContain(
      "Provide exactly one of 'prompt' or 'code', not both.",
    );
    // Nothing was created, so nothing to identify.
    expect(response.body.id).toBeUndefined();
  });

  itIf(canRunBrowser)(
    "rejects a malformed URL with 400 and leaves no dangling session",
    async () => {
      const createResponse = await browserCreateRaw(
        {
          url: "http://",
          code: "return page.url();",
          ttl: 60,
          activityTtl: 30,
          recordSession: false,
        },
        identity,
      );
      expect(createResponse.statusCode).toBe(400);
      expect(createResponse.body.success).toBe(false);
      expect(createResponse.body.id).toBeUndefined();

      const listResponse = await browserListRaw(identity, "active");
      expect(listResponse.statusCode).toBe(200);
      expect(Array.isArray(listResponse.body.sessions)).toBe(true);
    },
    scrapeTimeout,
  );

  itIf(canRunBrowser)(
    "rejects a private-network URL with 400 and leaves no dangling session",
    async () => {
      const before = await browserListRaw(identity, "active");
      const beforeCount = Array.isArray(before.body.sessions)
        ? before.body.sessions.length
        : 0;

      const createResponse = await browserCreateRaw(
        {
          url: "http://169.254.169.254/latest/meta-data/",
          code: "return page.url();",
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

  // ---------------------------------------------------------------------------
  // Backward compatibility: neither prompt nor code still creates a session.
  // ---------------------------------------------------------------------------

  itIf(canRunBrowser)(
    "creates a session with no prompt/code and no url (backward compatible)",
    async () => {
      const createResponse = await browserCreateRaw(
        { ttl: 60, activityTtl: 30, recordSession: false },
        identity,
      );
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.body.success).toBe(true);
      const sessionId = createResponse.body.id as string;
      // Create-only response carries no execution fields.
      expect(createResponse.body.exitCode).toBeUndefined();
      expect(createResponse.body.stdout).toBeUndefined();
      await browserDeleteRaw(sessionId, identity);
    },
    scrapeTimeout,
  );

  itIf(canRunBrowser)(
    "creates a session with a url but no prompt/code (backward compatible)",
    async () => {
      const targetUrl = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      const createResponse = await browserCreateRaw(
        { url: targetUrl, ttl: 60, activityTtl: 30, recordSession: false },
        identity,
      );
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.body.success).toBe(true);
      const sessionId = createResponse.body.id as string;
      expect(createResponse.body.exitCode).toBeUndefined();

      try {
        // Session already sits on the requested origin.
        const executeResponse = await browserExecuteRaw(
          sessionId,
          { language: "node", code: "return page.url();" },
          identity,
        );
        expect(executeResponse.statusCode).toBe(200);
        expect(String(executeResponse.body.result ?? "")).toContain(
          new URL(TEST_SUITE_WEBSITE).host,
        );
      } finally {
        await browserDeleteRaw(sessionId, identity);
      }
    },
    scrapeTimeout * 2,
  );

  // ---------------------------------------------------------------------------
  // Happy path: url + code in one call; session retained.
  // ---------------------------------------------------------------------------

  itIf(canRunBrowser)(
    "runs url + code in one call, sees the navigated page, and retains the session",
    async () => {
      const targetUrl = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      const createResponse = await browserCreateRaw(
        {
          url: targetUrl,
          language: "node",
          code: "return JSON.stringify({ url: page.url(), title: await page.title() });",
          ttl: 120,
          activityTtl: 120,
          recordSession: false,
        },
        identity,
      );
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.body.success).toBe(true);
      expect(createResponse.body.exitCode).toBe(0);
      expect(createResponse.body.killed).toBe(false);
      // The code saw the navigated page.
      expect(String(createResponse.body.result ?? "")).toContain(
        new URL(TEST_SUITE_WEBSITE).host,
      );
      const sessionId = createResponse.body.id as string;
      expect(typeof sessionId).toBe("string");

      try {
        // Session is retained: a follow-up execute against the returned id works.
        const followUp = await browserExecuteRaw(
          sessionId,
          { language: "node", code: "return page.url();" },
          identity,
        );
        expect(followUp.statusCode).toBe(200);
        expect(followUp.body.success).toBe(true);
        expect(String(followUp.body.result ?? "")).toContain(
          new URL(TEST_SUITE_WEBSITE).host,
        );
      } finally {
        await browserDeleteRaw(sessionId, identity);
      }
    },
    scrapeTimeout * 2,
  );

  // ---------------------------------------------------------------------------
  // Parity: one-call create+code == create-then-execute (same fields/semantics).
  // ---------------------------------------------------------------------------

  itIf(canRunBrowser)(
    "one-call create+code yields the same fields/semantics as create-then-execute",
    async () => {
      // Path A: one-call.
      const oneCall = await browserCreateRaw(
        {
          language: "node",
          code: "return 'parity-marker';",
          ttl: 60,
          activityTtl: 60,
          recordSession: false,
        },
        identity,
      );
      expect(oneCall.statusCode).toBe(200);
      const oneCallId = oneCall.body.id as string;

      // Path B: create then execute separately.
      const created = await browserCreateRaw(
        { ttl: 60, activityTtl: 60, recordSession: false },
        identity,
      );
      expect(created.statusCode).toBe(200);
      const twoStepId = created.body.id as string;
      const executed = await browserExecuteRaw(
        twoStepId,
        { language: "node", code: "return 'parity-marker';" },
        identity,
      );

      try {
        // Same execution semantics.
        expect(oneCall.body.success).toBe(executed.body.success);
        expect(oneCall.body.exitCode).toBe(executed.body.exitCode);
        expect(oneCall.body.killed).toBe(executed.body.killed);
        expect(oneCall.body.result).toBe(executed.body.result);
        // The one-call body ALSO carries session identity.
        expect(typeof oneCall.body.id).toBe("string");
        expect(typeof oneCall.body.cdpUrl).toBe("string");
      } finally {
        await browserDeleteRaw(oneCallId, identity);
        await browserDeleteRaw(twoStepId, identity);
      }
    },
    scrapeTimeout * 2,
  );

  // ---------------------------------------------------------------------------
  // Failure: url + failing code -> HTTP 200 success:false, session still alive.
  // ---------------------------------------------------------------------------

  itIf(canRunBrowser)(
    "returns HTTP 200 success:false when the initial code throws, keeping the session alive",
    async () => {
      const targetUrl = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      const createResponse = await browserCreateRaw(
        {
          url: targetUrl,
          language: "node",
          code: "throw new Error('boom');",
          ttl: 120,
          activityTtl: 120,
          recordSession: false,
        },
        identity,
      );
      // Execution failed, but the request succeeded and the session is retained.
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.body.success).toBe(false);
      expect(typeof createResponse.body.error).toBe("string");
      const sessionId = createResponse.body.id as string;
      expect(typeof sessionId).toBe("string");

      // Session is still alive: a follow-up execute succeeds, then we delete.
      const followUp = await browserExecuteRaw(
        sessionId,
        { language: "node", code: "return page.url();" },
        identity,
      );
      expect(followUp.statusCode).toBe(200);
      expect(followUp.body.success).toBe(true);

      const deleteResponse = await browserDeleteRaw(sessionId, identity);
      expect(deleteResponse.statusCode).toBe(200);
    },
    scrapeTimeout * 2,
  );

  // ---------------------------------------------------------------------------
  // Happy path: url + prompt in one call (AI-gated).
  // ---------------------------------------------------------------------------

  itIf(canRunPrompt)(
    "runs url + prompt in one call, reads the page, and reports output",
    async () => {
      const targetUrl = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      const createResponse = await browserCreateRaw(
        {
          url: targetUrl,
          prompt: "Report the exact title of the current page.",
          timeout: 120,
          ttl: 180,
          activityTtl: 180,
          recordSession: false,
        },
        identity,
      );
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.body.success).toBe(true);
      expect(createResponse.body.exitCode).toBe(0);
      expect(createResponse.body.killed).toBe(false);
      expect(typeof createResponse.body.output).toBe("string");
      const sessionId = createResponse.body.id as string;

      await browserDeleteRaw(sessionId, identity);
    },
    scrapeTimeout * 3,
  );
});
