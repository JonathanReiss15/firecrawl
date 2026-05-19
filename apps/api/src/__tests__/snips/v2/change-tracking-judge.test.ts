import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  HAS_AI,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { scrape, scrapeTimeout, idmux, Identity, scrapeRaw } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "change-tracking-judge",
    concurrency: 10,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

// Backwards-compat: every existing changeTracking call shape continues to
// work. The new `goal` and `judgeModel` fields are strictly optional.
describeIf(ALLOW_TEST_SUITE_WEBSITE)("changeTracking goal + judge", () => {
  const base = TEST_SUITE_WEBSITE;

  it(
    "backwards compat: goal omitted → no judgment field on response",
    async () => {
      const response = await scrape(
        {
          url: base,
          formats: [
            "markdown",
            {
              type: "changeTracking",
              modes: ["json"],
              tag: "judge-bc-omitted-" + Date.now(),
              schema: {
                type: "object",
                properties: { heading: { type: "string" } },
              },
              prompt: "Extract the page heading",
            },
          ],
        },
        identity,
      );
      expect(response.changeTracking).toBeDefined();
      // First run for this tag → changeStatus must be "new"; judgment only
      // fires on "changed" runs anyway. Either way the field is absent.
      expect(response.changeTracking?.judgment).toBeUndefined();
    },
    scrapeTimeout,
  );

  it(
    "accepts `goal` without validation error",
    async () => {
      const raw = await scrapeRaw(
        {
          url: base,
          formats: [
            "markdown",
            {
              type: "changeTracking",
              modes: ["json"],
              tag: "judge-validation-" + Date.now(),
              schema: {
                type: "object",
                properties: { heading: { type: "string" } },
              },
              prompt: "Extract the page heading",
              goal: "Tell me when the page heading changes",
            },
          ],
        },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      expect(raw.body?.success).toBe(true);
    },
    scrapeTimeout,
  );

  it(
    "rejects oversized goal (>2000 chars)",
    async () => {
      const raw = await scrapeRaw(
        {
          url: base,
          formats: [
            "markdown",
            {
              type: "changeTracking",
              modes: ["json"],
              tag: "judge-big-goal-" + Date.now(),
              goal: "x".repeat(2001),
            },
          ],
        },
        identity,
      );
      expect(raw.statusCode).toBe(400);
    },
    scrapeTimeout,
  );
});

// AI-dependent path. Only runs when an AI key is present (HAS_AI guard).
describeIf(ALLOW_TEST_SUITE_WEBSITE && HAS_AI)(
  "changeTracking judge — first-run new status",
  () => {
    const base = TEST_SUITE_WEBSITE;
    it(
      "first run with goal returns changeStatus=new and no judgment",
      async () => {
        const response = await scrape(
          {
            url: base,
            formats: [
              "markdown",
              {
                type: "changeTracking",
                modes: ["json"],
                tag: "judge-firstrun-" + Date.now(),
                schema: {
                  type: "object",
                  properties: { heading: { type: "string" } },
                },
                prompt: "Extract the page heading",
                goal: "Track when the page heading changes",
              },
            ],
          },
          identity,
        );
        expect(response.changeTracking).toBeDefined();
        expect(response.changeTracking?.changeStatus).toBe("new");
        // Judgment only fires when changeStatus === "changed".
        expect(response.changeTracking?.judgment).toBeUndefined();
      },
      scrapeTimeout,
    );
  },
);
