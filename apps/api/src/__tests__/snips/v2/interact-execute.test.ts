import { config } from "../../../config";
import { TEST_SELF_HOST, itIf } from "../lib";
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
