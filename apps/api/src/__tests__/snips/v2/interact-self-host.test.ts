import { config } from "../../../config";
import { TEST_SELF_HOST, itIf } from "../lib";
import {
  browserCreateRaw,
  browserDeleteRaw,
  browserExecuteRaw,
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
});
