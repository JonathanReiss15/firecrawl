import WebSocket from "ws";
import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { hasFormatOfType } from "../../../lib/format-utils";
import { supabase_service } from "../../../services/supabase";
import { extractDeterministicJson } from "../../../lib/deterministicJson/extract";
import type { CacheBackend } from "../../../lib/deterministicJson/core/cache";
import type { SandboxRunner } from "../../../lib/deterministicJson/sandbox/runExtractor";

const SANDBOX_URL = process.env.CODE_SANDBOX_URL ?? "ws://code-sandbox:3001";

const cache: CacheBackend = {
  async getExtractor(key) {
    const { data } = await supabase_service
      .from("deterministic_json_scripts")
      .select("code, created_at")
      .eq("cache_key", key)
      .maybeSingle();
    return data
      ? { code: data.code, createdAt: new Date(data.created_at).getTime() }
      : undefined;
  },
  async setExtractor(key, code, meta) {
    const now = new Date().toISOString();
    await supabase_service.from("deterministic_json_scripts").upsert(
      {
        cache_key: key,
        code,
        url: meta.url,
        model: meta.model,
        cache_version: meta.cacheVersion,
        updated_at: now,
        last_used_at: now,
      },
      { onConflict: "cache_key" },
    );
  },
  async getLlm(key) {
    const { data } = await supabase_service
      .from("deterministic_json_llm_cache")
      .select("response, created_at")
      .eq("cache_key", key)
      .maybeSingle();
    return data
      ? {
          response: data.response,
          createdAt: new Date(data.created_at).getTime(),
        }
      : undefined;
  },
  async setLlm(key, response) {
    await supabase_service
      .from("deterministic_json_llm_cache")
      .upsert(
        { cache_key: key, response, last_used_at: new Date().toISOString() },
        { onConflict: "cache_key" },
      );
  },
  async touch(key) {
    const now = new Date().toISOString();
    await Promise.all([
      supabase_service
        .from("deterministic_json_scripts")
        .update({ last_used_at: now })
        .eq("cache_key", key),
      supabase_service
        .from("deterministic_json_llm_cache")
        .update({ last_used_at: now })
        .eq("cache_key", key),
    ]);
  },
};

function sandboxRunner(endpoint: string): SandboxRunner {
  return job =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint);
      let done = false;
      const finish = (err: Error | null, value?: unknown) => {
        if (done) return;
        done = true;
        try {
          ws.close();
        } catch {
          /* closing */
        }
        err ? reject(err) : resolve(value);
      };
      ws.on("open", () =>
        ws.send(
          JSON.stringify({ type: "run", code: job.code, input: job.input }),
        ),
      );
      ws.on("message", async raw => {
        let frame: any;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }
        console.log("Sandbox frame", frame);
        if (frame.type === "host") {
          let value: unknown;
          let error: string | undefined;
          try {
            value = await job.onHost(frame.channel, frame.payload);
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "hostResult",
                id: frame.id,
                value,
                error,
              }),
            );
          }
        } else if (frame.type === "result") {
          finish(null, frame.value);
        } else if (frame.type === "error") {
          finish(new Error(frame.message));
        }
      });
      ws.on("error", err =>
        finish(err instanceof Error ? err : new Error(String(err))),
      );
      ws.on("close", () => finish(new Error("sandbox connection closed")));
    });
}

export async function performDeterministicJson(
  meta: Meta,
  document: Document,
): Promise<Document> {
  const format = hasFormatOfType(meta.options.formats, "deterministicJson");
  if (!format) return document;

  const warn = (msg: string) => {
    document.warning = msg + (document.warning ? " " + document.warning : "");
  };

  if (meta.internalOptions.zeroDataRetention) {
    warn("Deterministic JSON mode is not supported with zero data retention.");
    return document;
  }

  const html = document.html ?? document.rawHtml;
  if (!html) {
    warn("Deterministic JSON mode requires page HTML.");
    return document;
  }

  try {
    document.json = await extractDeterministicJson({
      url: document.metadata?.sourceURL ?? meta.url,
      prompt: format.prompt ?? "",
      jsonSchema: (format.schema ?? {}) as Record<string, unknown>,
      page: { html, markdown: document.markdown ?? "" },
      cache,
      sandbox: sandboxRunner(SANDBOX_URL),
      costTracking: meta.costTracking,
    });
  } catch (error) {
    meta.logger.error("Deterministic JSON extraction failed", { error });
    warn("Deterministic JSON extraction failed.");
  }

  return document;
}
