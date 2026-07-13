# Model benchmark — JSON / extract hot path

`model-benchmark.ts` compares the models Firecrawl currently pins in the
scrape/extract path against cheaper, newer candidates, using real extraction
scenarios lifted from the snips E2E tests.

## Why

The JSON / `extract` format is the dominant LLM workload. Today the code pins:

- `gpt-4o-mini` — default for `json`/`extract`, summary, clean-content, engine-picker, most of `/extract` (`selectModelForSchema` in `src/scraper/scrapeURL/transformers/llmExtract.ts`)
- `gpt-4.1` — recursive/`$ref` schemas and much of the `/extract` v2 loop
- `gpt-4.1-mini` — retry model

These are all pre-GPT-5 models. GPT-5-mini and Gemini 2.5 Flash-Lite are both
cheaper *and* at least as good at structured extraction, so this harness lets
us measure the swap before touching production defaults.

## Run

```bash
cd apps/api
# OpenAI only:
OPENAI_API_KEY=sk-... pnpm benchmark:models
# Include Gemini candidates:
OPENAI_API_KEY=sk-... GEMINI_API_KEY=... pnpm benchmark:models
# Benchmark on live-scraped content instead of embedded fixtures:
OPENAI_API_KEY=sk-... FIRECRAWL_API_KEY=fc-... pnpm benchmark:models
```

Env flags: `BENCH_MODELS` (comma-separated labels to include), `BENCH_REPEATS`
(default 3), `BENCH_MONTHLY_SPEND` (baseline $/mo for the projection, default
300000), `FIRECRAWL_API_KEY`/`FIRECRAWL_API_URL` (scrape `liveUrl` to markdown
for production-faithful input).

## What it reports

Per model: structured-output correctness against hand-labelled expected
answers, average latency, blended `$ / 1000 runs`, cost ratio vs the
`gpt-4o-mini` baseline, and a projected monthly spend scaled from a baseline.

## Caveats

- Talks to provider SDKs directly, so it is NOT affected by the `MODEL_NAME`
  env override used in production.
- The fixture set is small — accuracy is a smoke signal, not a leaderboard.
  Expand `SCENARIOS` with your hardest real schemas (recursive `$ref`, deep
  nesting, enums) before changing defaults.
- Prices in `PRICE_PER_M` mirror `calculateCost` in `llmExtract.ts`; update
  both together when pricing changes.
