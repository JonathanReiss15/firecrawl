export const CODEGEN_MODEL =
  process.env.EXTRACT_CODEGEN_MODEL ?? "gemini-3.1-flash-lite";
export const ANCHOR_MODEL =
  process.env.EXTRACT_ANCHOR_MODEL ?? "openai/gpt-oss-120b";
export const LIGHT_MODEL =
  process.env.EXTRACT_LIGHT_MODEL ?? "openai/gpt-oss-20b";

// Bump to invalidate every cached extractor at once.
export const CACHE_VERSION = 1;

export const MARKDOWN_BUDGET = 50_000;
export const HTML_BUDGET = 40_000;

export const ANCHOR_PER_BLOCK_BUDGET = 8_000;
export const ANCHOR_TOTAL_BUDGET = 60_000;
export const ANCHOR_MAX_BLOCKS = 16;
export const ANCHOR_MAX_PARENTS = 8;

export const CODEGEN_MAX_TOKENS = 16_384;
export const ANCHOR_PICKER_MAX_TOKENS = 2_000;
export const ASK_LLM_MAX_TOKENS = 2_048;

export const ASK_LLM_MAX_CALLS = 50;
