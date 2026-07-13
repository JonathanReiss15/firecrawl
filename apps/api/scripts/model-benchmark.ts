/**
 * Model benchmark for Firecrawl's JSON / extract hot path.
 *
 * Compares the models currently pinned in the scrape/extract code
 * (gpt-4o-mini, gpt-4.1, gpt-4.1-mini) against cheaper/newer candidates
 * (gpt-5-mini, gpt-5-nano, gpt-5, gemini-2.5-flash-lite, gemini-2.5-flash)
 * on real extraction scenarios lifted from the snips E2E tests.
 *
 * It measures, per model: structured-output correctness vs known-good
 * answers, latency, token usage, and blended $ cost, then prints a table
 * plus a projected-monthly-spend section.
 *
 * This is a standalone operator tool (lives outside src/, so knip ignores
 * it). It talks directly to the provider SDKs so results are NOT affected
 * by the MODEL_NAME env override used in production.
 *
 * Run:
 *   cd apps/api
 *   OPENAI_API_KEY=sk-... GEMINI_API_KEY=... pnpm benchmark:models
 *
 * Flags (env):
 *   BENCH_MODELS=gpt-4o-mini,gpt-5-mini    only run these labels
 *   BENCH_REPEATS=3                        runs per (model,scenario), default 3
 *   BENCH_MONTHLY_SPEND=300000             baseline $/mo to project against
 *   FIRECRAWL_API_KEY=fc-... FIRECRAWL_API_URL=https://api.firecrawl.dev
 *                                          if set, scrapes each scenario's
 *                                          liveUrl to markdown instead of
 *                                          using the embedded fixture, for a
 *                                          more production-faithful input.
 */

import { generateObject, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

type Provider = "openai" | "google";

interface Candidate {
  label: string;
  provider: Provider;
  modelId: string;
  note?: string;
}

// Cost is expressed per 1M tokens (USD), matching the units in
// llmExtract.ts:calculateCost. Kept local so the script has no heavy imports.
const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1-nano": { in: 0.1, out: 0.4 },
  "gpt-4o": { in: 2.5, out: 10.0 },
  "gpt-5": { in: 1.25, out: 10.0 },
  "gpt-5-mini": { in: 0.25, out: 2.0 },
  "gpt-5-nano": { in: 0.05, out: 0.4 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.5-pro": { in: 1.25, out: 10.0 },
};

const CANDIDATES: Candidate[] = [
  { label: "gpt-4o-mini", provider: "openai", modelId: "gpt-4o-mini", note: "current default (baseline)" },
  { label: "gpt-4.1", provider: "openai", modelId: "gpt-4.1", note: "current recursive-schema / retry model" },
  { label: "gpt-4.1-mini", provider: "openai", modelId: "gpt-4.1-mini", note: "current retry model" },
  { label: "gpt-5-mini", provider: "openai", modelId: "gpt-5-mini", note: "PRIMARY recommendation" },
  { label: "gpt-5-nano", provider: "openai", modelId: "gpt-5-nano", note: "high-volume / cheap tier" },
  { label: "gpt-5", provider: "openai", modelId: "gpt-5", note: "escalation tier" },
  { label: "gemini-2.5-flash-lite", provider: "google", modelId: "gemini-2.5-flash-lite", note: "cheapest viable" },
  { label: "gemini-2.5-flash", provider: "google", modelId: "gemini-2.5-flash", note: "long-context tier" },
];

// ---- Scenarios -------------------------------------------------------------
// Content, schema, prompt and expected answers are lifted from the snips
// tests (v1/json-extract-format.test.ts, v1/extract.test.ts,
// v2/scrape.test.ts "JSON format", v2/scrape-formats.test.ts). The embedded
// fixtures make the benchmark runnable without the scraper; set
// FIRECRAWL_API_KEY to scrape liveUrl instead.

interface Check {
  desc: string;
  ok: (o: any) => boolean;
}

interface Scenario {
  name: string;
  liveUrl?: string;
  content: string;
  prompt: string;
  schema: any;
  checks: Check[];
}

const FIRECRAWL_PAGE = [
  "# Firecrawl",
  "",
  "Turn any website into LLM-ready data. Firecrawl crawls, scrapes and",
  "extracts clean markdown and structured JSON from any URL.",
  "",
  "Our mission is to make the web accessible to AI agents and developers.",
  "",
  "Firecrawl is open source — the code is available on our GitHub repository",
  "and licensed under AGPL. Star us on [GitHub](https://github.com/firecrawl/firecrawl).",
  "",
  "## Features",
  "- Scrape: single-page to clean markdown",
  "- Crawl: entire sites",
  "- Extract: structured JSON via schema",
  "",
  "[Pricing](https://firecrawl.dev/pricing) · [Docs](https://docs.firecrawl.dev) · [Blog](https://firecrawl.dev/blog)",
  "",
  "Sign up with email and password to get an API key.",
].join("\n");

const EXAMPLE_JSON_RECORD = JSON.stringify(
  {
    userId: 1,
    id: 1,
    title: "sunt aut facere repellat provident occaecati excepturi optio reprehenderit",
    body: "quia et suscipit\\nsuscipit recusandae consequuntur expedita et cum\\nreprehenderit molestiae ut ut quas totam\\nnostrum rerum est autem sunt rem eveniet architecto",
  },
  null,
  2,
);

const isStr = (v: any) => typeof v === "string" && v.length > 0;
const isBool = (v: any) => typeof v === "boolean";

const SCENARIOS: Scenario[] = [
  {
    name: "company-facts (mission/SSO/open-source)",
    liveUrl: "https://www.firecrawl.dev",
    content: FIRECRAWL_PAGE,
    prompt:
      "Based on the information on the page, find what the company's mission is and whether it supports SSO, and whether it is open source.",
    schema: {
      type: "object",
      properties: {
        company_mission: { type: "string" },
        supports_sso: { type: "boolean" },
        is_open_source: { type: "boolean" },
      },
      required: ["company_mission", "supports_sso", "is_open_source"],
      additionalProperties: false,
    },
    checks: [
      { desc: "company_mission is a non-empty string", ok: o => isStr(o?.company_mission) },
      { desc: "supports_sso === false (page never mentions SSO)", ok: o => o?.supports_sso === false },
      { desc: "is_open_source === true", ok: o => o?.is_open_source === true },
    ],
  },
  {
    name: "heading + hasLinks",
    liveUrl: "https://www.firecrawl.dev",
    content: FIRECRAWL_PAGE,
    prompt: "Extract the main heading of the page and whether the page contains any links.",
    schema: {
      type: "object",
      properties: {
        mainHeading: { type: "string" },
        hasLinks: { type: "boolean" },
      },
      required: ["mainHeading", "hasLinks"],
      additionalProperties: false,
    },
    checks: [
      { desc: "mainHeading mentions Firecrawl", ok: o => isStr(o?.mainHeading) && /firecrawl/i.test(o.mainHeading) },
      { desc: "hasLinks === true", ok: o => o?.hasLinks === true },
    ],
  },
  {
    name: "heading + description",
    liveUrl: "https://www.firecrawl.dev",
    content: FIRECRAWL_PAGE,
    prompt: "Extract the main heading and description",
    schema: {
      type: "object",
      properties: {
        heading: { type: "string" },
        description: { type: "string" },
      },
      required: ["heading", "description"],
      additionalProperties: false,
    },
    checks: [
      { desc: "heading is a non-empty string", ok: o => isStr(o?.heading) },
      { desc: "description is a non-empty string", ok: o => isStr(o?.description) },
    ],
  },
  {
    name: "json-record extraction (example.json)",
    content: "Here is the JSON document served by the endpoint:\n\n```json\n" + EXAMPLE_JSON_RECORD + "\n```",
    prompt: "Extract the fields from the JSON record on the page.",
    schema: {
      type: "object",
      properties: {
        userId: { type: "number" },
        id: { type: "number" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["userId", "id", "title", "body"],
      additionalProperties: false,
    },
    checks: [
      { desc: "userId === 1", ok: o => o?.userId === 1 },
      { desc: "id === 1", ok: o => o?.id === 1 },
      { desc: "title is a non-empty string", ok: o => isStr(o?.title) },
      { desc: "body is a non-empty string", ok: o => isStr(o?.body) },
    ],
  },
  {
    name: "company_name (constrained, unsupported keyword tolerated)",
    liveUrl: "https://www.firecrawl.dev",
    content: FIRECRAWL_PAGE,
    prompt: "Extract the company name.",
    schema: {
      type: "object",
      properties: {
        company_name: { type: "string", pattern: "^[a-zA-Z0-9]+$" },
      },
      required: ["company_name"],
      additionalProperties: false,
    },
    checks: [{ desc: "company_name is a non-empty string", ok: o => isStr(o?.company_name) }],
  },
  {
    name: "company info minimal {name}",
    liveUrl: "https://www.firecrawl.dev",
    content: FIRECRAWL_PAGE,
    prompt: "Extract company info as JSON",
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    checks: [{ desc: "name is a non-empty string", ok: o => isStr(o?.name) }],
  },
];

// ---- Provider clients ------------------------------------------------------
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
});

function modelFor(c: Candidate) {
  return c.provider === "openai" ? openai(c.modelId) : google(c.modelId);
}

// ---- Optional live scrape --------------------------------------------------
async function scrapeMarkdown(url: string): Promise<string | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  const base = process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev";
  try {
    const res = await fetch(`${base}/v2/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    const body: any = await res.json();
    return body?.data?.markdown ?? null;
  } catch {
    return null;
  }
}

// ---- Run one (model, scenario) --------------------------------------------
interface RunResult {
  passed: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  error?: string;
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function runOnce(c: Candidate, s: Scenario, content: string): Promise<RunResult> {
  const total = s.checks.length;
  const isGpt5 = c.modelId.startsWith("gpt-5");
  const start = Date.now();
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res: any = await generateObject({
        model: modelFor(c),
        schema: jsonSchema(s.schema),
        temperature: isGpt5 ? 1 : 0,
        prompt:
          `Extract structured data from the following web page content. ` +
          `Only use information present in the content.\n\n` +
          `Instruction: ${s.prompt}\n\n--- PAGE CONTENT ---\n${content}`,
        providerOptions: c.provider === "openai" ? { openai: { strictJsonSchema: true } } : undefined,
      });
      const obj = res.object;
      const passed = s.checks.filter(ck => {
        try {
          return ck.ok(obj);
        } catch {
          return false;
        }
      }).length;
      const u = res.usage ?? {};
      return {
        passed,
        total,
        inputTokens: u.inputTokens ?? u.promptTokens ?? 0,
        outputTokens: u.outputTokens ?? u.completionTokens ?? 0,
        ms: Date.now() - start,
      };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  return { passed: 0, total, inputTokens: 0, outputTokens: 0, ms: Date.now() - start, error: lastErr };
}

// ---- Aggregate -------------------------------------------------------------
interface Agg {
  label: string;
  note: string;
  runs: number;
  passed: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  errors: number;
}

function fmt(n: number, d = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function costUSD(label: string, inTok: number, outTok: number): number {
  const p = PRICE_PER_M[label];
  if (!p) return 0;
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required.");
    process.exit(1);
  }
  const repeats = Number(process.env.BENCH_REPEATS ?? 3);
  const monthly = Number(process.env.BENCH_MONTHLY_SPEND ?? 300000);
  const filter = (process.env.BENCH_MODELS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  let candidates = CANDIDATES;
  if (filter.length) candidates = candidates.filter(c => filter.includes(c.label));
  const haveGoogle = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  if (!haveGoogle) {
    const dropped = candidates.filter(c => c.provider === "google").map(c => c.label);
    if (dropped.length) console.warn(`No GEMINI_API_KEY/GOOGLE_API_KEY — skipping: ${dropped.join(", ")}`);
    candidates = candidates.filter(c => c.provider !== "google");
  }

  // Resolve content per scenario (live scrape if configured).
  const contents: Record<string, string> = {};
  for (const s of SCENARIOS) {
    let content = s.content;
    if (s.liveUrl && process.env.FIRECRAWL_API_KEY) {
      const md = await scrapeMarkdown(s.liveUrl);
      if (md) {
        content = md;
        console.log(`[live] scraped ${s.liveUrl} (${md.length} chars) for "${s.name}"`);
      } else {
        console.log(`[live] scrape failed for ${s.liveUrl}, using fixture for "${s.name}"`);
      }
    }
    contents[s.name] = content;
  }

  console.log(`\nBenchmark: ${candidates.length} models x ${SCENARIOS.length} scenarios x ${repeats} repeats\n`);

  const aggs: Agg[] = [];
  for (const c of candidates) {
    const agg: Agg = {
      label: c.label,
      note: c.note ?? "",
      runs: 0,
      passed: 0,
      total: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms: 0,
      errors: 0,
    };
    for (const s of SCENARIOS) {
      for (let r = 0; r < repeats; r++) {
        const res = await runOnce(c, s, contents[s.name]);
        agg.runs++;
        agg.passed += res.passed;
        agg.total += res.total;
        agg.inputTokens += res.inputTokens;
        agg.outputTokens += res.outputTokens;
        agg.ms += res.ms;
        if (res.error) {
          agg.errors++;
          console.log(`  ! ${c.label} / ${s.name} #${r + 1}: ${res.error}`);
        }
      }
    }
    aggs.push(agg);
    const acc = agg.total ? (100 * agg.passed) / agg.total : 0;
    console.log(
      `${c.label.padEnd(24)} acc=${fmt(acc, 1)}%  avgMs=${fmt(agg.ms / Math.max(agg.runs, 1), 0)}  ` +
        `tok(in/out)=${agg.inputTokens}/${agg.outputTokens}  errors=${agg.errors}`,
    );
  }

  // ---- Results table -------------------------------------------------------
  const baseline = aggs.find(a => a.label === "gpt-4o-mini");
  const baseCostPerRun = baseline
    ? costUSD(baseline.label, baseline.inputTokens, baseline.outputTokens) / Math.max(baseline.runs, 1)
    : 0;

  console.log("\n\n=== RESULTS ===\n");
  const header = [
    "model".padEnd(24),
    "acc%".padStart(7),
    "avgMs".padStart(8),
    "$/1k runs".padStart(11),
    "vs 4o-mini".padStart(11),
    "note",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length + 20));
  for (const a of aggs) {
    const acc = a.total ? (100 * a.passed) / a.total : 0;
    const costPerRun = costUSD(a.label, a.inputTokens, a.outputTokens) / Math.max(a.runs, 1);
    const per1k = costPerRun * 1000;
    const rel = baseCostPerRun ? costPerRun / baseCostPerRun : 0;
    console.log(
      [
        a.label.padEnd(24),
        fmt(acc, 1).padStart(7),
        fmt(a.ms / Math.max(a.runs, 1), 0).padStart(8),
        ("$" + fmt(per1k, 2)).padStart(11),
        (rel ? fmt(rel, 2) + "x" : "-").padStart(11),
        a.note,
      ].join("  "),
    );
  }

  // ---- Monthly projection --------------------------------------------------
  // Assumes the current JSON/extract spend runs on gpt-4o-mini-class pricing.
  // Scales the baseline $/mo by each model's measured cost ratio. This is a
  // first-order estimate: it assumes similar token counts per request, which
  // the benchmark measures per model (so it already captures verbosity
  // differences), but real traffic mix will vary.
  console.log(`\n=== PROJECTED MONTHLY SPEND (baseline $${monthly.toLocaleString()}/mo on gpt-4o-mini) ===\n`);
  for (const a of aggs) {
    const costPerRun = costUSD(a.label, a.inputTokens, a.outputTokens) / Math.max(a.runs, 1);
    const rel = baseCostPerRun ? costPerRun / baseCostPerRun : 0;
    if (!rel) continue;
    const projected = monthly * rel;
    const delta = monthly - projected;
    const sign = delta >= 0 ? "save" : "add";
    console.log(
      `${a.label.padEnd(24)} ~$${fmt(projected, 0)}/mo  (${sign} $${fmt(Math.abs(delta), 0)}/mo)`,
    );
  }
  console.log(
    "\nNote: correctness here is measured against a small hand-labelled fixture set; " +
      "treat accuracy as a smoke signal, not a leaderboard. Re-run with FIRECRAWL_API_KEY " +
      "set to benchmark on live-scraped content, and expand SCENARIOS with your own " +
      "hardest schemas before changing production defaults.",
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
