import crypto from "crypto";
import { config } from "../../../config";
import { HAS_AI, TEST_PRODUCTION, TEST_SELF_HOST, itIf } from "../lib";
import {
  browserCreateRaw,
  browserDeleteRaw,
  browserExecuteRaw,
  idmux,
  scrapeTimeout,
  type Identity,
} from "./lib";

// Runs in both the production and self-hosted suites, as long as a browser
// service is configured.
const canRun = !!config.BROWSER_SERVICE_URL;

// The prompt path additionally needs a model. Production cloud has one;
// self-hosted only when OPENAI_API_KEY / OLLAMA_BASE_URL is configured.
const canRunPrompt = canRun && (TEST_PRODUCTION || HAS_AI);

describe("Interact execute success semantics", () => {
  let identity: Identity;

  beforeAll(async () => {
    if (TEST_SELF_HOST) {
      // Self-hosted mode runs without database auth.
      identity = { apiKey: "local", teamId: "bypass" };
    } else {
      identity = await idmux({
        name: "interact-execute",
        concurrency: 10,
        credits: 1_000_000,
      });
    }
  }, 10000 + scrapeTimeout);

  itIf(canRun)(
    "returns success: true for an execution that exits 0",
    async () => {
      let sessionId: string | null = null;

      try {
        const createResponse = await browserCreateRaw(
          { ttl: 60, activityTtl: 60, recordSession: false },
          identity,
        );
        expect(createResponse.statusCode).toBe(200);
        expect(createResponse.body.success).toBe(true);
        sessionId = createResponse.body.id as string;

        const executeResponse = await browserExecuteRaw(
          sessionId,
          { language: "bash", code: "echo hello" },
          identity,
        );
        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body).toMatchObject({
          success: true,
          exitCode: 0,
          killed: false,
        });
        expect(executeResponse.body.stdout).toContain("hello");
        expect(executeResponse.body.error).toBeUndefined();
      } finally {
        if (sessionId) {
          await browserDeleteRaw(sessionId, identity);
        }
      }
    },
    scrapeTimeout,
  );

  itIf(canRun)(
    "returns success: false with HTTP 200 for an execution that exits non-zero",
    async () => {
      let sessionId: string | null = null;

      try {
        const createResponse = await browserCreateRaw(
          { ttl: 60, activityTtl: 60, recordSession: false },
          identity,
        );
        expect(createResponse.statusCode).toBe(200);
        expect(createResponse.body.success).toBe(true);
        sessionId = createResponse.body.id as string;

        const executeResponse = await browserExecuteRaw(
          sessionId,
          { language: "bash", code: "echo oops >&2; exit 3" },
          identity,
        );
        // Accepted executions keep HTTP 200 even when the code fails --
        // failure is signaled via the success field.
        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(false);
        expect(executeResponse.body.exitCode).toBe(3);
        expect(executeResponse.body.killed).toBe(false);
        expect(typeof executeResponse.body.error).toBe("string");
        expect(executeResponse.body.error.length).toBeGreaterThan(0);
        expect(executeResponse.body.stderr).toContain("oops");
      } finally {
        if (sessionId) {
          await browserDeleteRaw(sessionId, identity);
        }
      }
    },
    scrapeTimeout,
  );

  itIf(canRun)(
    "returns success: false and killed: true for an execution that exceeds its timeout",
    async () => {
      let sessionId: string | null = null;

      try {
        const createResponse = await browserCreateRaw(
          { ttl: 60, activityTtl: 60, recordSession: false },
          identity,
        );
        expect(createResponse.statusCode).toBe(200);
        expect(createResponse.body.success).toBe(true);
        sessionId = createResponse.body.id as string;

        const executeResponse = await browserExecuteRaw(
          sessionId,
          { language: "bash", code: "sleep 30", timeout: 1 },
          identity,
        );
        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(false);
        expect(executeResponse.body.killed).toBe(true);
        expect(typeof executeResponse.body.error).toBe("string");
      } finally {
        if (sessionId) {
          await browserDeleteRaw(sessionId, identity);
        }
      }
    },
    scrapeTimeout,
  );
});

describe("Interact execute prompt parity", () => {
  let identity: Identity;

  beforeAll(async () => {
    if (TEST_SELF_HOST) {
      identity = { apiKey: "local", teamId: "bypass" };
    } else {
      identity = await idmux({
        name: "interact-execute-prompt",
        concurrency: 10,
        credits: 1_000_000,
      });
    }
  }, 10000 + scrapeTimeout);

  // Body validation runs before the session lookup / browser / AI, so these
  // hold in every configuration — no browser or model needed.
  it("returns 400 when both 'prompt' and 'code' are provided, executing neither", async () => {
    const response = await browserExecuteRaw(
      crypto.randomUUID(),
      {
        code: "console.log('should not run')",
        prompt: "Click the login button",
        language: "node",
      },
      identity,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe(
      "Provide exactly one of 'prompt' or 'code', not both.",
    );
    // Neither the code path nor the agent path runs.
    expect(response.body.stdout).toBeUndefined();
    expect(response.body.output).toBeUndefined();
  });

  it("returns 400 when neither 'prompt' nor 'code' is provided", async () => {
    const response = await browserExecuteRaw(
      crypto.randomUUID(),
      { language: "node" },
      identity,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe(
      "Either 'code' or 'prompt' must be provided.",
    );
  });

  itIf(canRunPrompt)(
    "executes a prompt that reads page state and reports it back",
    async () => {
      let sessionId: string | null = null;

      try {
        const createResponse = await browserCreateRaw(
          { ttl: 120, activityTtl: 120, recordSession: false },
          identity,
        );
        expect(createResponse.statusCode).toBe(200);
        expect(createResponse.body.success).toBe(true);
        sessionId = createResponse.body.id as string;

        // Set a deterministic page state via code first.
        const setResponse = await browserExecuteRaw(
          sessionId,
          {
            language: "node",
            code: `await page.setContent("<title>Parity Marker 4711</title><h1>hello</h1>");`,
          },
          identity,
        );
        expect(setResponse.statusCode).toBe(200);
        expect(setResponse.body.success).toBe(true);

        // Ask the agent to read it back.
        const promptResponse = await browserExecuteRaw(
          sessionId,
          {
            prompt: "Report the exact title of the current page.",
            timeout: 120,
          },
          identity,
        );
        expect(promptResponse.statusCode).toBe(200);
        expect(promptResponse.body.success).toBe(true);
        expect(promptResponse.body.exitCode).toBe(0);
        expect(promptResponse.body.killed).toBe(false);
        expect(typeof promptResponse.body.output).toBe("string");
        expect(promptResponse.body.output).toContain("4711");
      } finally {
        if (sessionId) {
          await browserDeleteRaw(sessionId, identity);
        }
      }
    },
    scrapeTimeout * 2,
  );

  itIf(canRunPrompt)(
    "shares state across a prompt run and a later code exec on the same session",
    async () => {
      let sessionId: string | null = null;

      try {
        const createResponse = await browserCreateRaw(
          { ttl: 120, activityTtl: 120, recordSession: false },
          identity,
        );
        expect(createResponse.statusCode).toBe(200);
        expect(createResponse.body.success).toBe(true);
        sessionId = createResponse.body.id as string;

        // Prompt navigates the live page to a data URL with a known marker.
        const promptResponse = await browserExecuteRaw(
          sessionId,
          {
            prompt:
              "Navigate to the URL data:text/html,<title>Shared 8899</title> and confirm when done.",
            timeout: 120,
          },
          identity,
        );
        expect(promptResponse.statusCode).toBe(200);
        expect(promptResponse.body.success).toBe(true);

        // Deterministic code reads the title back off the SAME session's page,
        // proving one retained browser session across both executions.
        const readResponse = await browserExecuteRaw(
          sessionId,
          { language: "node", code: "return await page.title();" },
          identity,
        );
        expect(readResponse.statusCode).toBe(200);
        expect(readResponse.body.success).toBe(true);
        expect(readResponse.body.result).toContain("8899");
      } finally {
        if (sessionId) {
          await browserDeleteRaw(sessionId, identity);
        }
      }
    },
    scrapeTimeout * 2,
  );

  itIf(canRunPrompt)(
    "returns success: false with diagnostic fields (HTTP 200) when a prompt run fails",
    async () => {
      let sessionId: string | null = null;

      try {
        const createResponse = await browserCreateRaw(
          { ttl: 120, activityTtl: 120, recordSession: false },
          identity,
        );
        expect(createResponse.statusCode).toBe(200);
        expect(createResponse.body.success).toBe(true);
        sessionId = createResponse.body.id as string;

        // A 1s step timeout is too short for the agent to complete any real
        // task, so the run is killed / exits non-zero. The request is still
        // accepted (HTTP 200); failure is signaled via the body.
        const promptResponse = await browserExecuteRaw(
          sessionId,
          {
            prompt:
              "Exhaustively enumerate and click every interactive element on this page one by one.",
            timeout: 1,
          },
          identity,
        );
        expect(promptResponse.statusCode).toBe(200);
        expect(promptResponse.body.success).toBe(false);
        expect(typeof promptResponse.body.error).toBe("string");
        expect(promptResponse.body.error.length).toBeGreaterThan(0);
      } finally {
        if (sessionId) {
          await browserDeleteRaw(sessionId, identity);
        }
      }
    },
    scrapeTimeout * 2,
  );
});
