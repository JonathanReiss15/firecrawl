// Detect selectors that are too strict: they match 0 elements, yet a looser
// variant (child combinator `>` relaxed to descendant) matches at least one, so
// we can tell the model exactly what to fix. Only static string/template literals
// are considered.
import { parseDocument } from "./dom";

export interface TooStrictSelector {
  selector: string;
  loosened: string;
  count: number;
}

// Pull literal selectors out of querySelector / querySelectorAll calls. Skips
// template literals containing ${...} interpolation (not statically knowable).
const SELECTOR_CALL = /querySelector(?:All)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

export function extractSelectorLiterals(code: string): string[] {
  const out = new Set<string>();
  for (const match of code.matchAll(SELECTOR_CALL)) {
    const selector = match[2];
    if (selector && !selector.includes("${")) out.add(selector);
  }
  return [...out];
}

export function tooStrictSelectors(
  code: string,
  html: string,
): TooStrictSelector[] {
  const selectors = extractSelectorLiterals(code).filter(s => s.includes(">"));
  if (selectors.length === 0) return [];

  const doc = parseDocument(html);
  const count = (selector: string): number | null => {
    try {
      return doc.querySelectorAll(selector).length;
    } catch {
      return null; // invalid CSS - the sandbox surfaces those on its own
    }
  };

  const out: TooStrictSelector[] = [];
  for (const selector of selectors) {
    if (count(selector) !== 0) continue;
    const loosened = selector.replace(/\s*>\s*/g, " ");
    const loosenedCount = count(loosened);
    if (loosenedCount != null && loosenedCount > 0) {
      out.push({ selector, loosened, count: loosenedCount });
    }
  }
  return out;
}

export function tooStrictFeedback(broken: TooStrictSelector[]): string {
  return (
    `Some selectors matched 0 elements even though the target IS on the page - a ` +
    `child combinator (\`>\`) is breaking on a wrapper element you couldn't see in ` +
    `the sample. Switch these to descendant combinators:\n` +
    broken
      .map(
        b =>
          `- \`${b.selector}\` matched 0; \`${b.loosened}\` matches ${b.count}`,
      )
      .join("\n") +
    `\nRewrite these (and re-check your other selectors for the same issue). Leave ` +
    `genuinely-absent fields empty - never broaden a selector just to match something.`
  );
}
