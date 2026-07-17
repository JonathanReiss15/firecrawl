import crypto from "crypto";
import { config } from "../../../config";
import { PYTHON_PAGE_SYNC_SCRIPT } from "../../../lib/scrape-interact/runtime-page-sync";
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
  scrapeStopInteractiveBrowserRaw,
  scrapeInteractRaw,
  scrapeRaw,
  scrapeTimeout,
} from "./lib";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function interactWithReplicaRetry(
  jobId: string,
  body: {
    code?: string;
    prompt?: string;
    language?: "python" | "node" | "bash";
    timeout?: number;
  },
  identity: Identity,
  attempts: number = 5,
) {
  let lastResponse: Awaited<ReturnType<typeof scrapeInteractRaw>> | null = null;

  for (let i = 0; i < attempts; i += 1) {
    const response = await scrapeInteractRaw(jobId, body, identity);
    lastResponse = response;
    if (response.statusCode !== 404) return response;
    await sleep(500);
  }

  return lastResponse!;
}

type InteractRuntime = "python" | "node" | "bash";

/**
 * Shared scrape → interact lifecycle:
 * scrape (planting a replay marker) → N interact calls in one runtime →
 * DELETE /v2/scrape/:jobId/interact.
 *
 * The stop always runs in a `finally` so sessions never leak, even when an
 * interact call fails; its response is returned so callers can assert the
 * DELETE succeeded without masking an earlier failure.
 */
async function runScrapeInteractLifecycle(opts: {
  identity: Identity;
  language: InteractRuntime;
  codes: string[];
  replayMarker: string;
}) {
  const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;

  const scrapeResponse = await scrapeRaw(
    {
      url,
      origin: "website-replay-test",
      waitFor: 500,
      actions: [
        {
          type: "executeJavascript",
          script: `window.__fcMatrixReplayMarker = "${opts.replayMarker}";`,
        },
      ],
    },
    opts.identity,
  );

  expect(scrapeResponse.statusCode).toBe(200);
  expect(scrapeResponse.body.success).toBe(true);
  expect(typeof scrapeResponse.body.scrape_id).toBe("string");
  const scrapeId = scrapeResponse.body.scrape_id as string;

  const responses: Awaited<ReturnType<typeof scrapeInteractRaw>>[] = [];
  let stopResponse: Awaited<
    ReturnType<typeof scrapeStopInteractiveBrowserRaw>
  > | null = null;

  try {
    for (const code of opts.codes) {
      responses.push(
        await interactWithReplicaRetry(
          scrapeId,
          { language: opts.language, timeout: 60, code },
          opts.identity,
        ),
      );
    }
  } finally {
    stopResponse = await scrapeStopInteractiveBrowserRaw(
      scrapeId,
      opts.identity,
    );
  }

  return { url, responses, stopResponse };
}

function lastStdoutLine(response: { body: { stdout?: string } }): string {
  return response.body.stdout?.trim().split("\n").filter(Boolean).pop() ?? "";
}

/**
 * Parse the JSON payload an interact call produced. The node REPL reports a
 * final expression through `result` while python/bash report through stdout,
 * so accept whichever channel carries a JSON object.
 */
function jsonPayload(response: {
  body: { stdout?: string; result?: string };
}): Record<string, unknown> {
  const candidates = [
    response.body.result?.trim() ?? "",
    lastStdoutLine(response),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new Error(
    `No JSON payload found in interact response (result: ${JSON.stringify(
      response.body.result,
    )}, stdout: ${JSON.stringify(response.body.stdout)})`,
  );
}

function expectExecSuccess(
  response: Awaited<ReturnType<typeof scrapeInteractRaw>>,
) {
  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(response.body.exitCode).toBe(0);
  expect(response.body.killed).toBe(false);
}

function expectStopSuccess(
  stopResponse: Awaited<
    ReturnType<typeof scrapeStopInteractiveBrowserRaw>
  > | null,
) {
  expect(stopResponse).not.toBeNull();
  expect(stopResponse!.statusCode).toBe(200);
  expect(stopResponse!.body.success).toBe(true);
}

describe("Scrape browser interact replay", () => {
  let identity: Identity;
  let otherIdentity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "scrape-browser-replay",
      concurrency: 20,
      credits: 1_000_000,
    });
    otherIdentity = await idmux({
      name: "scrape-browser-replay-other",
      concurrency: 10,
      credits: 1_000_000,
    });
  }, 10000 + scrapeTimeout);

  const canRunReplayHappyPath =
    ALLOW_TEST_SUITE_WEBSITE &&
    !!config.BROWSER_SERVICE_URL &&
    (TEST_PRODUCTION || HAS_FIRE_ENGINE);

  itIf(canRunReplayHappyPath)(
    "replays scrape URL/waitFor/actions before interactive code runs",
    async () => {
      const marker = crypto.randomUUID();
      const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      let scrapeId: string | null = null;

      try {
        const scrapeResponse = await scrapeRaw(
          {
            url,
            origin: "website-replay-test",
            waitFor: 500,
            actions: [
              {
                type: "executeJavascript",
                script: `window.__firecrawlReplayMarker = "${marker}";`,
              },
            ],
          },
          identity,
        );

        expect(scrapeResponse.statusCode).toBe(200);
        expect(scrapeResponse.body.success).toBe(true);
        expect(typeof scrapeResponse.body.scrape_id).toBe("string");
        scrapeId = scrapeResponse.body.scrape_id as string;

        const executeResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "node",
            timeout: 60,
            code: `
              const replayMarker = await page.evaluate(() => window.__firecrawlReplayMarker ?? null);
              console.log(replayMarker ?? "missing-marker");
            `,
          },
          identity,
        );

        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);
        expect(executeResponse.body.stdout).toContain(marker);
        expect(typeof executeResponse.body.cdpUrl).toBe("string");
        expect(executeResponse.body.cdpUrl.length).toBeGreaterThan(0);
      } finally {
        if (scrapeId) {
          await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
        }
      }
    },
    scrapeTimeout,
  );

  itIf(canRunReplayHappyPath)(
    "keeps a non-blank replay tab in the foreground for follow-up execs",
    async () => {
      const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      let scrapeId: string | null = null;

      try {
        const scrapeResponse = await scrapeRaw(
          {
            url,
            origin: "website-replay-test",
            actions: [
              {
                type: "executeJavascript",
                script: "window.open('about:blank', '_blank');",
              },
            ],
          },
          identity,
        );

        expect(scrapeResponse.statusCode).toBe(200);
        expect(scrapeResponse.body.success).toBe(true);
        expect(typeof scrapeResponse.body.scrape_id).toBe("string");
        scrapeId = scrapeResponse.body.scrape_id as string;

        const executeResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "node",
            timeout: 60,
            code: `
              const visibleUrls = [];
              for (const candidate of page.context().pages()) {
                try {
                  const isVisible = await candidate.evaluate(
                    () => document.visibilityState === "visible",
                  );
                  if (isVisible) {
                    visibleUrls.push(candidate.url());
                  }
                } catch {}
              }

              const visibleNonBlankUrl =
                visibleUrls.find(value => value !== "about:blank") ?? "about:blank";
              console.log(visibleNonBlankUrl);
            `,
          },
          identity,
        );

        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);

        const visibleUrl =
          executeResponse.body.stdout
            ?.trim()
            .split("\n")
            .filter(Boolean)
            .pop() ?? "";

        expect(visibleUrl).not.toBe("about:blank");
        expect(visibleUrl).toContain(TEST_SUITE_WEBSITE);
      } finally {
        if (scrapeId) {
          await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
        }
      }
    },
    scrapeTimeout,
  );

  itIf(canRunReplayHappyPath)(
    "opens a single content tab (no stray blank tab) when a session starts",
    async () => {
      const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      let scrapeId: string | null = null;

      try {
        const scrapeResponse = await scrapeRaw(
          {
            url,
            origin: "website-replay-test",
          },
          identity,
        );

        expect(scrapeResponse.statusCode).toBe(200);
        expect(scrapeResponse.body.success).toBe(true);
        expect(typeof scrapeResponse.body.scrape_id).toBe("string");
        scrapeId = scrapeResponse.body.scrape_id as string;

        // Session creation primes agent-browser and consolidates tabs, so
        // user code must see exactly one tab: the content page.
        const executeResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "node",
            timeout: 60,
            code: `
              console.log(JSON.stringify(page.context().pages().map(p => p.url())));
            `,
          },
          identity,
        );

        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);

        const lastLine =
          executeResponse.body.stdout
            ?.trim()
            .split("\n")
            .filter(Boolean)
            .pop() ?? "[]";
        const tabUrls = JSON.parse(lastLine) as string[];

        expect(tabUrls).toHaveLength(1);
        expect(tabUrls[0]).not.toBe("about:blank");
        expect(tabUrls[0]).toContain(TEST_SUITE_WEBSITE);
      } finally {
        if (scrapeId) {
          await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
        }
      }
    },
    scrapeTimeout,
  );

  itIf(!TEST_SELF_HOST)(
    "returns 400 for invalid scrape job id format",
    async () => {
      const response = await scrapeInteractRaw(
        "not-a-valid-uuid",
        {
          code: "console.log('hi')",
          language: "node",
        },
        identity,
      );

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe(
        "Invalid job ID format. Job ID must be a valid UUID.",
      );
    },
  );

  itIf(!TEST_SELF_HOST)(
    "returns 404 when scrape job does not exist",
    async () => {
      const response = await scrapeInteractRaw(
        crypto.randomUUID(),
        {
          code: "console.log('hi')",
          language: "node",
        },
        identity,
      );

      expect(response.statusCode).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Job not found.");
    },
  );

  itIf(ALLOW_TEST_SUITE_WEBSITE && !!config.IDMUX_URL)(
    "returns 403 when scrape job belongs to another team",
    async () => {
      if (identity.teamId === otherIdentity.teamId) {
        return;
      }

      const scrapeResponse = await scrapeRaw(
        {
          url: `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`,
          origin: "website-replay-test",
        },
        identity,
      );

      expect(scrapeResponse.statusCode).toBe(200);
      expect(scrapeResponse.body.success).toBe(true);
      expect(typeof scrapeResponse.body.scrape_id).toBe("string");

      const scrapeId = scrapeResponse.body.scrape_id as string;
      const executeResponse = await interactWithReplicaRetry(
        scrapeId,
        {
          code: "console.log('should fail')",
          language: "node",
        },
        otherIdentity,
      );

      expect(executeResponse.statusCode).toBe(403);
      expect(executeResponse.body.success).toBe(false);
      expect(executeResponse.body.error).toBe("Forbidden.");
    },
    scrapeTimeout,
  );

  itIf(ALLOW_TEST_SUITE_WEBSITE && !TEST_SELF_HOST)(
    "returns replay-context error when scrape data is not retained",
    async () => {
      const scrapeResponse = await scrapeRaw(
        {
          url: `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`,
          origin: "website-replay-test",
          zeroDataRetention: true,
        },
        identity,
      );

      expect(scrapeResponse.statusCode).toBe(200);
      expect(scrapeResponse.body.success).toBe(true);
      expect(typeof scrapeResponse.body.scrape_id).toBe("string");

      const scrapeId = scrapeResponse.body.scrape_id as string;
      const executeResponse = await interactWithReplicaRetry(
        scrapeId,
        {
          code: "console.log('should not run')",
          language: "node",
        },
        identity,
      );

      expect(executeResponse.statusCode).toBe(409);
      expect(executeResponse.body.success).toBe(false);
      expect(executeResponse.body.error).toContain(
        "Replay context is unavailable",
      );
    },
    scrapeTimeout,
  );
});

// ---------------------------------------------------------------------------
// Cross-runtime state-attachment matrix
//
// Every runtime (node / python / bash) must attach to the same live page of a
// scrape-bound session, keep that attachment across consecutive interact
// calls, report failures with consistent fields, and allow the session to be
// stopped cleanly — including after a failed execution.
//
// Regression coverage for firecrawl/firecrawl#3498: the Python runtime binds
// its `page` variable when its REPL starts (before the scrape replay runs),
// and used to keep pointing at a tab that session-creation tab consolidation
// had closed, so every Python exec on the session failed with
// `TargetClosedError` while node and bash worked.
// ---------------------------------------------------------------------------

describe("Scrape browser cross-runtime interact matrix", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "scrape-browser-matrix",
      concurrency: 20,
      credits: 1_000_000,
    });
  }, 10000 + scrapeTimeout);

  const canRunMatrix =
    ALLOW_TEST_SUITE_WEBSITE &&
    !!config.BROWSER_SERVICE_URL &&
    (TEST_PRODUCTION || HAS_FIRE_ENGINE);

  itIf(canRunMatrix)(
    "node: attaches to the replayed page and keeps state across calls",
    async () => {
      const replayMarker = crypto.randomUUID();
      const runtimeMarker = crypto.randomUUID();

      const { url, responses, stopResponse } = await runScrapeInteractLifecycle(
        {
          identity,
          language: "node",
          replayMarker,
          codes: [
            // The REPL reports the final expression through `result`
            // (console.log output does not reliably reach stdout).
            [
              `const matrixNodeFirst = {`,
              `  url: page.url(),`,
              `  title: await page.title(),`,
              `  replayMarker: await page.evaluate(() => window.__fcMatrixReplayMarker ?? null),`,
              `};`,
              `await page.evaluate(value => { window.__fcMatrixRuntimeMarker = value; }, ${JSON.stringify(runtimeMarker)});`,
              `JSON.stringify(matrixNodeFirst)`,
            ].join("\n"),
            [
              `const matrixNodeSecond = await page.evaluate(() => ({`,
              `  replayMarker: window.__fcMatrixReplayMarker ?? null,`,
              `  runtimeMarker: window.__fcMatrixRuntimeMarker ?? null,`,
              `}));`,
              `JSON.stringify(matrixNodeSecond)`,
            ].join("\n"),
          ],
        },
      );

      expectStopSuccess(stopResponse);

      expectExecSuccess(responses[0]);
      const first = jsonPayload(responses[0]);
      expect(first.url).toContain(TEST_SUITE_WEBSITE);
      expect(url).toContain(TEST_SUITE_WEBSITE);
      expect(first.replayMarker).toBe(replayMarker);

      expectExecSuccess(responses[1]);
      const second = jsonPayload(responses[1]);
      expect(second.replayMarker).toBe(replayMarker);
      expect(second.runtimeMarker).toBe(runtimeMarker);
    },
    scrapeTimeout * 2,
  );

  itIf(canRunMatrix)(
    "python: attaches to the replayed page and keeps state across calls",
    async () => {
      const replayMarker = crypto.randomUUID();
      const runtimeMarker = crypto.randomUUID();

      const { url, responses, stopResponse } = await runScrapeInteractLifecycle(
        {
          identity,
          language: "python",
          replayMarker,
          codes: [
            // The python REPL processes Playwright protocol events only while
            // an exec runs, so page.url can lag; read location.href through a
            // real protocol round-trip instead. This first exec is the exact
            // invariant the creation-time page sync guarantees: the binding
            // answers a protocol round-trip and is on the replayed target
            // URL. A stale/closed attachment (issue #3498) fails here with
            // TargetClosedError.
            [
              `import json`,
              `matrix_href = await page.evaluate("() => location.href")`,
              `matrix_title = await page.title()`,
              `matrix_replay_marker = await page.evaluate("() => window.__fcMatrixReplayMarker || null")`,
              `await page.evaluate("value => { window.__fcMatrixRuntimeMarker = value; }", ${JSON.stringify(runtimeMarker)})`,
              `print(json.dumps({"href": matrix_href, "title": matrix_title, "replayMarker": matrix_replay_marker, "closed": page.is_closed()}))`,
            ].join("\n"),
            [
              `import json`,
              `matrix_state = await page.evaluate("() => ({ replayMarker: window.__fcMatrixReplayMarker || null, runtimeMarker: window.__fcMatrixRuntimeMarker || null })")`,
              `print(json.dumps(matrix_state))`,
            ].join("\n"),
          ],
        },
      );

      expectStopSuccess(stopResponse);

      expectExecSuccess(responses[0]);
      const first = jsonPayload(responses[0]);
      expect(first.closed).toBe(false);
      // The binding must sit on the exact replayed target URL (the unique
      // testId query pins it to this test's page), not merely "some page".
      expect(first.href).toContain(TEST_SUITE_WEBSITE);
      expect(first.href).toContain(url.split("?")[1]);
      expect(first.replayMarker).toBe(replayMarker);

      expectExecSuccess(responses[1]);
      const second = jsonPayload(responses[1]);
      expect(second.replayMarker).toBe(replayMarker);
      expect(second.runtimeMarker).toBe(runtimeMarker);
    },
    scrapeTimeout * 2,
  );

  itIf(canRunMatrix)(
    "python: forced stale binding fails, page sync heals it (break-and-heal)",
    async () => {
      const breakTabId = crypto.randomUUID();
      const breakUrl = `${TEST_SUITE_WEBSITE}?testId=${breakTabId}`;
      const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;

      const scrapeResponse = await scrapeRaw(
        { url, origin: "website-replay-test" },
        identity,
      );
      expect(scrapeResponse.statusCode).toBe(200);
      expect(scrapeResponse.body.success).toBe(true);
      expect(typeof scrapeResponse.body.scrape_id).toBe("string");
      const scrapeId = scrapeResponse.body.scrape_id as string;

      let stopResponse: Awaited<
        ReturnType<typeof scrapeStopInteractiveBrowserRaw>
      > | null = null;

      try {
        // Force the #3498 root-cause state deterministically: from node,
        // open a fresh tab on a real URL and close the tab every runtime
        // was attached to. The python REPL's binding is now guaranteed
        // stale no matter how the session-creation race resolved.
        const breakResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "node",
            timeout: 60,
            code: [
              `const fcBreakNext = await page.context().newPage();`,
              `await fcBreakNext.goto(${JSON.stringify(breakUrl)}, { waitUntil: "domcontentloaded" });`,
              `const fcBreakOld = page;`,
              `page = fcBreakNext;`,
              `await fcBreakOld.close();`,
              `JSON.stringify({ brokenUrl: page.url() })`,
            ].join("\n"),
          },
          identity,
        );
        expectExecSuccess(breakResponse);
        expect(jsonPayload(breakResponse).brokenUrl).toContain(breakTabId);

        // Negative control: the next python exec must fail with the exact
        // TargetClosedError semantics reported in #3498. This proves the
        // test can trigger the bug on demand.
        const brokenProbe = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "python",
            timeout: 60,
            code: `print(await page.title())`,
          },
          identity,
        );
        expect(brokenProbe.statusCode).toBe(200);
        expect(brokenProbe.body.success).toBe(false);
        expect(typeof brokenProbe.body.exitCode).toBe("number");
        expect(brokenProbe.body.exitCode).not.toBe(0);
        expect(brokenProbe.body.killed).toBe(false);
        expect(brokenProbe.body.stderr).toMatch(
          /TargetClosedError|has been closed/,
        );

        // Heal: the same script the controller runs at session creation
        // must re-attach the python binding to the surviving live tab.
        const healResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "python",
            timeout: 60,
            code: PYTHON_PAGE_SYNC_SCRIPT,
          },
          identity,
        );
        expectExecSuccess(healResponse);

        // Post-heal: python round-trips again and sits on the live tab.
        const healedProbe = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "python",
            timeout: 60,
            code: [
              `import json`,
              `matrix_healed_href = await page.evaluate("() => location.href")`,
              `matrix_healed_title = await page.title()`,
              `print(json.dumps({"href": matrix_healed_href, "title": matrix_healed_title, "closed": page.is_closed()}))`,
            ].join("\n"),
          },
          identity,
        );
        expectExecSuccess(healedProbe);
        const healed = jsonPayload(healedProbe);
        expect(healed.closed).toBe(false);
        expect(healed.href).toContain(breakTabId);
      } finally {
        stopResponse = await scrapeStopInteractiveBrowserRaw(
          scrapeId,
          identity,
        );
      }

      expectStopSuccess(stopResponse);
    },
    scrapeTimeout * 2,
  );

  itIf(canRunMatrix)(
    "bash: agent-browser stays attached across consecutive calls",
    async () => {
      const replayMarker = crypto.randomUUID();

      const { responses, stopResponse } = await runScrapeInteractLifecycle({
        identity,
        language: "bash",
        replayMarker,
        codes: [
          `agent-browser get url && agent-browser get title`,
          `agent-browser get url`,
        ],
      });

      expectStopSuccess(stopResponse);

      expectExecSuccess(responses[0]);
      expect(responses[0].body.stdout).toContain(TEST_SUITE_WEBSITE);

      expectExecSuccess(responses[1]);
      expect(responses[1].body.stdout).toContain(TEST_SUITE_WEBSITE);
    },
    scrapeTimeout * 2,
  );

  const failureCases: {
    language: InteractRuntime;
    code: string;
    stderrNeedle: string;
  }[] = [
    {
      language: "node",
      code: `throw new Error("firecrawl-matrix-node-failure");`,
      stderrNeedle: "firecrawl-matrix-node-failure",
    },
    {
      language: "python",
      code: `raise RuntimeError("firecrawl-matrix-python-failure")`,
      stderrNeedle: "firecrawl-matrix-python-failure",
    },
    {
      // Fail inside a subshell: a bare top-level `exit` would terminate the
      // session's persistent shell instead of reporting an exit code.
      language: "bash",
      code: `(echo "firecrawl-matrix-bash-failure" >&2; exit 3)`,
      stderrNeedle: "firecrawl-matrix-bash-failure",
    },
  ];

  // A prompt run and a python code exec are a supported mix on one retained
  // session. The agent's actions churn tabs, and per-action tab sync only
  // repoints the Node REPL's `page` — so without the post-run Python page sync
  // the following python exec can hit a stale/closed binding (#3498) mid-run.
  // Gated on AI: the prompt path needs a model. TEST_PRODUCTION cloud has one;
  // otherwise require a configured local model (HAS_AI).
  itIf(canRunMatrix && (TEST_PRODUCTION || HAS_AI))(
    "prompt then python: agent run leaves the python binding on the live page",
    async () => {
      const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;

      const scrapeResponse = await scrapeRaw(
        { url, origin: "website-replay-test", waitFor: 500 },
        identity,
      );
      expect(scrapeResponse.statusCode).toBe(200);
      expect(scrapeResponse.body.success).toBe(true);
      const scrapeId = scrapeResponse.body.scrape_id as string;

      try {
        // A minimal, deterministic-outcome prompt: just read the page. Its
        // point is to run the agent loop (which primes agent-browser, opens
        // and consolidates tabs, and finishes with the post-run python sync),
        // not to exercise complex automation.
        const promptResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            prompt: "Report the exact title of the current page.",
            timeout: 60,
          },
          identity,
        );
        expect(promptResponse.statusCode).toBe(200);
        expect(promptResponse.body.success).toBe(true);

        // The invariant the post-run sync guarantees: the FIRST python exec
        // after the prompt run does a real protocol round-trip on the live
        // content page — same URL, not closed. Pre-fix this failed with
        // TargetClosedError whenever the agent's tab churn stranded the
        // python binding.
        const pythonResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "python",
            timeout: 60,
            code: [
              `import json`,
              `matrix_href = await page.evaluate("() => location.href")`,
              `print(json.dumps({"href": matrix_href, "closed": page.is_closed()}))`,
            ].join("\n"),
          },
          identity,
        );

        expectExecSuccess(pythonResponse);
        const payload = jsonPayload(pythonResponse);
        expect(payload.closed).toBe(false);
        expect(payload.href).toContain(TEST_SUITE_WEBSITE);
        expect(payload.href).toContain(url.split("?")[1]);
      } finally {
        await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
      }
    },
    scrapeTimeout * 2,
  );

  for (const failureCase of failureCases) {
    itIf(canRunMatrix)(
      `${failureCase.language}: failing code reports consistent failure fields and still stops cleanly`,
      async () => {
        const { responses, stopResponse } = await runScrapeInteractLifecycle({
          identity,
          language: failureCase.language,
          replayMarker: crypto.randomUUID(),
          codes: [failureCase.code],
        });

        // The DELETE must succeed even though execution failed.
        expectStopSuccess(stopResponse);

        const response = responses[0];
        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(false);
        expect(typeof response.body.exitCode).toBe("number");
        expect(response.body.exitCode).not.toBe(0);
        expect(response.body.killed).toBe(false);
        expect(response.body.stderr).toContain(failureCase.stderrNeedle);
        expect(typeof response.body.error).toBe("string");
        expect(response.body.error.length).toBeGreaterThan(0);
      },
      scrapeTimeout * 2,
    );
  }
});
