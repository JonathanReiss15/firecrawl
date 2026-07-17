import { config } from "../../../config";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_AI,
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
  scrapeTimeout,
} from "./lib";

// Interact Recipes: a successful prompt run is reduced to a reusable command
// stream (`recipe: { mode: "learn" }`), which later calls execute in a fresh
// session without a model (`recipe: { recipeId, version }`). Drift repair
// (`onDrift: "repair-safe"`) is exercised by the local lifecycle demo — it
// needs a deterministically drifted stored recipe, which snips cannot seed.
describe("Interact recipes", () => {
  let identity: Identity;

  beforeAll(async () => {
    if (TEST_SELF_HOST) {
      // Self-hosted mode runs without database auth.
      identity = { apiKey: "local", teamId: "bypass" };
    } else {
      identity = await idmux({
        name: "interact-recipes",
        concurrency: 20,
        credits: 1_000_000,
      });
    }
  }, 10000 + scrapeTimeout);

  // Session creation + navigation happen entirely in the browser service, so
  // recipes only need a browser service and a reachable target website — no
  // scrape engine is involved.
  const canRunBrowser =
    ALLOW_TEST_SUITE_WEBSITE && !!config.BROWSER_SERVICE_URL;
  // Learning additionally needs a model for the discovery run.
  const canRunLearn = canRunBrowser && (TEST_PRODUCTION || HAS_AI);

  // ---------------------------------------------------------------------------
  // Validation failures (no browser service needed — schema rejects first).
  // ---------------------------------------------------------------------------

  it("returns 400 when recipe mode 'learn' is requested without a prompt", async () => {
    const response = await browserCreateRaw(
      {
        url: TEST_SUITE_WEBSITE,
        ttl: 60,
        activityTtl: 30,
        recipe: { mode: "learn" },
      },
      identity,
    );
    expect(response.statusCode).toBe(400);
  });

  it("returns 400 when recipe is combined with code", async () => {
    const response = await browserCreateRaw(
      {
        url: TEST_SUITE_WEBSITE,
        code: "return page.url();",
        ttl: 60,
        activityTtl: 30,
        recipe: { recipeId: "rcp_x", version: 1 },
      },
      identity,
    );
    expect(response.statusCode).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Learn, then execute the learned recipe in a fresh session without a model.
  // ---------------------------------------------------------------------------

  // Create a plain session and navigate it to the test-suite website through
  // the code path. One-call `url` rejects private-network targets (SSRF), so
  // a local self-hosted test-suite website must be reached via code instead.
  async function createNavigatedSession(): Promise<string> {
    const createResponse = await browserCreateRaw(
      { ttl: 300, activityTtl: 120, recordSession: false },
      identity,
    );
    expect(createResponse.statusCode).toBe(200);
    const sessionId = createResponse.body.id as string;
    const gotoResponse = await browserExecuteRaw(
      sessionId,
      {
        language: "node",
        timeout: 60,
        code: `await page.goto(${JSON.stringify(TEST_SUITE_WEBSITE)}, { waitUntil: "domcontentloaded" }); return page.url();`,
      },
      identity,
    );
    expect(gotoResponse.statusCode).toBe(200);
    expect(gotoResponse.body.success).toBe(true);
    return sessionId;
  }

  itIf(canRunLearn)(
    "learns a recipe from a prompt, then executes it deterministically",
    async () => {
      const sessionIds: string[] = [];
      try {
        // 1. Learn: prompt run captures a validated command stream.
        const learnSessionId = await createNavigatedSession();
        sessionIds.push(learnSessionId);
        const learnResponse = await browserExecuteRaw(
          learnSessionId,
          {
            prompt:
              'Return the current page title as a JSON object shaped exactly like {"title": "..."}.',
            timeout: 60,
            recipe: { mode: "learn", includeSteps: true },
          },
          identity,
        );
        expect(learnResponse.statusCode).toBe(200);
        expect(learnResponse.body.success).toBe(true);
        expect(learnResponse.body.recipe).toMatchObject({
          version: 1,
          route: "learned",
        });
        const { recipeId, steps } = learnResponse.body.recipe;
        expect(typeof recipeId).toBe("string");
        // The captured stream must end with the extraction eval.
        expect(Array.isArray(steps)).toBe(true);
        expect(steps[steps.length - 1].args[0]).toBe("eval");
        const learnedResult = JSON.parse(learnResponse.body.result);
        expect(typeof learnedResult.title).toBe("string");
        expect(learnedResult.title.length).toBeGreaterThan(0);

        // 2. Execute: fresh session, pinned recipe, no model, no prompt.
        const executeSessionId = await createNavigatedSession();
        sessionIds.push(executeSessionId);
        const executeResponse = await browserExecuteRaw(
          executeSessionId,
          {
            timeout: 60,
            recipe: { recipeId, version: 1 },
          },
          identity,
        );
        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);
        expect(executeResponse.body.recipe).toMatchObject({
          recipeId,
          version: 1,
          route: "executed",
        });
        const executedResult = JSON.parse(executeResponse.body.result);
        expect(executedResult).toEqual(learnedResult);
      } finally {
        for (const sessionId of sessionIds) {
          await browserDeleteRaw(sessionId, identity).catch(() => {});
        }
      }
    },
    10 * scrapeTimeout,
  );

  itIf(canRunBrowser)(
    "returns 404 for a pinned recipe that does not exist",
    async () => {
      let sessionId: string | null = null;
      try {
        const createResponse = await browserCreateRaw(
          { ttl: 120, activityTtl: 60, recordSession: false },
          identity,
        );
        expect(createResponse.statusCode).toBe(200);
        sessionId = createResponse.body.id as string;

        const response = await browserExecuteRaw(
          sessionId,
          {
            timeout: 60,
            recipe: { recipeId: "rcp_does_not_exist", version: 1 },
          },
          identity,
        );
        expect(response.statusCode).toBe(404);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toContain("not found");
      } finally {
        if (sessionId)
          await browserDeleteRaw(sessionId, identity).catch(() => {});
      }
    },
    5 * scrapeTimeout,
  );
});
