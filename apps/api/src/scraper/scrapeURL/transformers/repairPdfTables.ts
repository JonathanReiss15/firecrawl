import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";

/**
 * fire-pdf reconstructs PDF tables from the text layer by position. When two
 * paired-direction headers sit adjacent with no whitespace gap in the source
 * PDF -- a common layout in timetables and price tables, e.g. "MANILA to
 * BANGKOK" immediately followed by "BANGKOK to MANILA" -- they get glued into a
 * single cell: "MANILA to BANGKOKBANGKOK to MANILA". The two route names become
 * indistinguishable, which hurts both human reading and downstream JSON
 * extraction.
 *
 * This is a deterministic, schema-free repair. Inside markdown table rows it
 * detects the reversal pattern `<A> to <B><B> to <A>` (the middle location
 * appears twice back-to-back, bracketed by " to ") and splits it back into two
 * cells: "<A> to <B> | <B> to <A>". The doubled-middle plus the surrounding
 * " to " is a highly specific signal, so normal prose and well-formed cells are
 * left untouched.
 *
 * Scope note: this only repairs the *concatenation* symptom on content that
 * survived reconstruction. Tables that fire-pdf drops or garbles upstream
 * cannot be recovered here -- that fix belongs in the fire-pdf reconstruction
 * engine itself.
 */

// Match, within a single markdown cell:
//   group 1: "<prefix> to "   (the left header, e.g. "MANILA to ")
//   group 2: "<mid>"          (the location that got doubled, >=2 chars)
//   \2     : "<mid>" again    (the immediate repetition -- the bug signature)
//   group 3: " to <suffix>"   (the right header tail, e.g. " to MANILA")
// `[^|]` keeps each part inside one table cell so we never merge across columns.
const CONCATENATED_HEADER = /([^|]+? to )([^|]{2,}?)\2( to [^|]+)/g;

/**
 * Pure string transform. Exported for unit testing.
 */
export function repairConcatenatedTableHeaders(markdown: string): string {
  // Fast bail: the pattern requires two " to " occurrences, so a document with
  // none (or only one) can never match.
  if (!markdown.includes(" to ")) {
    return markdown;
  }

  return markdown
    .split("\n")
    .map(line => {
      // Only touch markdown table rows to keep the heuristic well-scoped.
      if (!line.trimStart().startsWith("|")) {
        return line;
      }
      return line.replace(CONCATENATED_HEADER, "$1$2 | $2$3");
    })
    .join("\n");
}

function isPdfDocument(meta: Meta, document: Document): boolean {
  const metadata = document.metadata as
    | {
        contentType?: string;
        numPages?: number;
        sourceURL?: string;
        url?: string;
      }
    | undefined;

  if (metadata?.contentType?.toLowerCase().includes("pdf")) {
    return true;
  }
  if (metadata?.numPages !== undefined) {
    return true;
  }

  const candidate = (
    metadata?.url ??
    metadata?.sourceURL ??
    meta.rewrittenUrl ??
    meta.url ??
    ""
  )
    .split("?")[0]
    .toLowerCase();
  return candidate.endsWith(".pdf");
}

/**
 * Transformer: repair concatenated paired-direction table headers in markdown
 * produced from PDFs. No-op for non-PDF sources and for PDFs that don't exhibit
 * the pattern.
 */
export async function repairPdfTables(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!document.markdown) {
    return document;
  }
  if (!isPdfDocument(meta, document)) {
    return document;
  }

  const before = document.markdown;
  const after = repairConcatenatedTableHeaders(before);
  if (after !== before) {
    meta.logger.info("Repaired concatenated PDF table headers", {
      addedChars: after.length - before.length,
    });
    document.markdown = after;
  }

  return document;
}
