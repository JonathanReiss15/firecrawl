import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("MCP action log migration", () => {
  const migration = readFileSync(
    resolve(
      __dirname,
      "../../db/migrations/20260712000100_create_mcp_action_logs.sql",
    ),
    "utf8",
  );

  it("enforces terminal statuses, auth shape, and one event per request", () => {
    expect(migration).toContain("CREATE TABLE public.mcp_action_logs");
    expect(migration).not.toContain("CREATE TABLE IF NOT EXISTS");
    expect(migration).toContain("status IN ('success', 'error')");
    expect(migration).toContain("mcp_action_logs_auth_shape");
    expect(migration).toContain("UNIQUE (team_id, request_id)");
  });

  it("has bounded retention and an expiry cleanup index", () => {
    expect(migration).toContain("interval '30 days'");
    expect(migration).toContain("mcp_action_logs_expires_idx");
  });

  it("contains only the metadata fields allowed by the runtime contract", () => {
    expect(migration).not.toMatch(
      /user_agent|raw_ip|arguments|request_body|response_body/,
    );
    expect(migration).toContain("mcp.firecrawl.dev/v2/mcp-oauth");
  });
});
