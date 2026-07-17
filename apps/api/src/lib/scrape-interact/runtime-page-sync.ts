import { logger as _logger } from "../logger";
import {
  browserServiceRequest,
  BrowserServiceExecResponse,
} from "./browser-service-client";

const PYTHON_PAGE_SYNC_TIMEOUT = 15;

// ---------------------------------------------------------------------------
// Runtime page-sync scripts for scrape-bound Interact sessions.
//
// The browser service keeps one persistent REPL per language per session, and
// each REPL binds its own `page` variable independently. The Node REPL's
// binding is repointed by the tab-sync script below, but the Python REPL binds
// `page` when it starts (at session creation, before the scrape replay runs)
// and never re-binds on its own. When tab consolidation closes the page the
// Python REPL happened to bind, every subsequent Python exec fails with
// `TargetClosedError: Target page, context or browser has been closed`
// (firecrawl/firecrawl#3498). The Python sync script re-attaches that binding
// to the surviving content page.
// ---------------------------------------------------------------------------

/**
 * Close every tab except the content tab, repoint the Node REPL's `page`
 * variable, and bring the survivor to the foreground.
 *
 * The Node REPL shares one global scope across execs, so the script is
 * wrapped in an async IIFE: `const` declarations stay function-scoped and
 * the script can run any number of times in one session. (The previous
 * top-level `const ctx = ...` version threw `SyntaxError: Identifier 'ctx'
 * has already been declared` on every run after the first, silently turning
 * follow-up tab syncs into no-ops. A bare `{ ... }` block does not work
 * either — the REPL parses a leading brace as an object literal.) The bare
 * `page = ...` assignment intentionally resolves to the REPL-global binding.
 */
export const NODE_TAB_SYNC_SCRIPT = [
  `await (async () => {`,
  `  const fcSyncPages = page.context().pages();`,
  `  if (fcSyncPages.length > 1) {`,
  `    const fcSyncTarget = fcSyncPages.find(p => { const u = p.url(); return u && u !== 'about:blank'; }) || fcSyncPages[fcSyncPages.length - 1];`,
  `    for (const p of fcSyncPages) { if (p !== fcSyncTarget) await p.close().catch(() => {}); }`,
  `    page = fcSyncTarget;`,
  `  }`,
  `  await page.bringToFront();`,
  `})();`,
].join("\n");

/**
 * Re-attach the Python REPL's `page` binding to the live content page.
 *
 * The Python REPL only pumps Playwright protocol events while an exec is
 * running, so its wrappers can be stale (pages closed by the Node tab sync
 * still report `is_closed() == False`, `page.url` can lag behind real
 * navigations, and tabs opened by other runtimes since the last Python exec
 * may not appear in `page.context.pages` yet). The script therefore yields
 * to the event loop first so the connection reader can drain queued
 * protocol messages, then probes candidates with real protocol round-trips
 * — a closed page raises, a live one answers — and prefers the page that
 * reports a non-blank `location.href`. Assignments persist in the REPL
 * globals, so the corrected binding sticks for all later Python execs.
 * Runs are idempotent; Python has no redeclaration hazard.
 */
export const PYTHON_PAGE_SYNC_SCRIPT = [
  `import asyncio as _fc_sync_asyncio`,
  `await _fc_sync_asyncio.sleep(0.25)`,
  `_fc_sync_target = None`,
  `try:`,
  `    _fc_sync_pages = list(page.context.pages)`,
  `except Exception:`,
  `    _fc_sync_pages = []`,
  `for _fc_sync_page in _fc_sync_pages:`,
  `    try:`,
  `        _fc_sync_href = await _fc_sync_page.evaluate("() => location.href")`,
  `    except Exception:`,
  `        continue`,
  `    if _fc_sync_href and _fc_sync_href != "about:blank":`,
  `        _fc_sync_target = _fc_sync_page`,
  `        break`,
  `if _fc_sync_target is None:`,
  `    for _fc_sync_page in _fc_sync_pages:`,
  `        try:`,
  `            await _fc_sync_page.title()`,
  `        except Exception:`,
  `            continue`,
  `        _fc_sync_target = _fc_sync_page`,
  `        break`,
  `if _fc_sync_target is not None:`,
  `    page = _fc_sync_target`,
].join("\n");

/**
 * Re-attach the Python REPL's `page` binding to the live content page on the
 * given browser session, running `PYTHON_PAGE_SYNC_SCRIPT`.
 *
 * Best-effort by design: the Node and bash runtimes work regardless of the
 * Python binding, so a failure here must never tear down the session — it is
 * logged and swallowed. Shared by the two moments that can strand the Python
 * binding: session creation (after tab consolidation, before the caller's
 * first exec) and the end of a prompt-driven agent run (whose actions may have
 * opened or closed tabs since the last Python exec). See firecrawl/firecrawl#3498.
 */
export async function syncPythonRuntimePage(
  browserId: string,
  logger: typeof _logger,
): Promise<void> {
  try {
    await browserServiceRequest<BrowserServiceExecResponse>(
      "POST",
      `/browsers/${browserId}/exec`,
      {
        code: PYTHON_PAGE_SYNC_SCRIPT,
        language: "python",
        timeout: PYTHON_PAGE_SYNC_TIMEOUT,
        origin: "python_page_sync",
      },
    );
  } catch (error) {
    logger.warn("Failed to sync Python runtime page binding", { error });
  }
}
