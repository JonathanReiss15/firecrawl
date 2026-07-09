import { Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { logger as _logger } from "../../lib/logger";
import { ErrorResponse, RequestWithAuth } from "./types";
import { db, dbRr } from "../../db/connection";
import * as schema from "../../db/schema";
import { apiKeyToFcApiKey } from "../../lib/parseApi";
import { autumnService } from "../../services/autumn/autumn.service";

const logger = _logger.child({ module: "team-api-keys" });

const spendLimitSchema = z.object({
  // Spend limit is expressed in Firecrawl credits (our billing unit), capped
  // over a rolling day/week/month window regardless of remaining balance.
  credits: z.number().int().positive().max(100_000_000),
  interval: z.enum(["day", "week", "month"]),
});

const createApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    // Optional per-key spend limit. Omit for no limit.
    spendLimit: spendLimitSchema.nullish(),
  })
  .strict();

interface CreateApiKeyResponse {
  success: true;
  apiKey: {
    id: number;
    token: string;
    name: string | null;
    teamId: string;
    ownerId: string | null;
    spendLimit: { credits: number; interval: "day" | "week" | "month" } | null;
    createdAt: string | null;
  };
}

export async function createApiKeyController(
  req: RequestWithAuth<{}, unknown, CreateApiKeyResponse | ErrorResponse>,
  res: Response<CreateApiKeyResponse | ErrorResponse>,
): Promise<void> {
  const body = createApiKeyRequestSchema.parse(req.body ?? {});
  const teamId = req.auth.team_id;
  const spendLimit = body.spendLimit ?? null;

  // There's no session user on a pure-API call, so the new key inherits its
  // owner from the API key that authenticated this request (scoped to the team
  // to be safe). Falls back to null (unowned) if the caller's key is unowned.
  let ownerId: string | null = null;
  const callerKeyId = req.acuc?.api_key_id;
  if (callerKeyId) {
    const [callerKey] = await dbRr
      .select({ owner_id: schema.api_keys.owner_id })
      .from(schema.api_keys)
      .where(
        and(
          eq(schema.api_keys.id, callerKeyId),
          eq(schema.api_keys.team_id, teamId),
        ),
      )
      .limit(1);
    ownerId = callerKey?.owner_id ?? null;
  }

  const [created] = await db
    .insert(schema.api_keys)
    .values({ team_id: teamId, name: body.name ?? null, owner_id: ownerId })
    .returning({
      id: schema.api_keys.id,
      key: schema.api_keys.key,
      name: schema.api_keys.name,
      created_at: schema.api_keys.created_at,
    });

  if (!created?.key) {
    logger.error("Failed to create API key", { teamId });
    res.status(500).json({ success: false, error: "Failed to create API key" });
    return;
  }

  const token = apiKeyToFcApiKey(created.key)!;

  if (spendLimit) {
    const applied = await autumnService.setApiKeySpendLimit({
      teamId,
      apiKeyId: created.id,
      credits: spendLimit.credits,
      interval: spendLimit.interval,
    });

    // Roll back so we never hand back a key missing the limit the caller
    // asked for (which could otherwise overspend unbounded).
    if (!applied) {
      await db
        .delete(schema.api_keys)
        .where(eq(schema.api_keys.id, created.id));
      logger.error("Rolled back API key after spend-limit failure", {
        teamId,
        apiKeyId: created.id,
      });
      res.status(502).json({
        success: false,
        error:
          "Could not apply the spend limit, so the API key was not created. Please try again.",
      });
      return;
    }
  }

  logger.info("Created API key", {
    teamId,
    apiKeyId: created.id,
    hasSpendLimit: spendLimit !== null,
  });

  res.status(200).json({
    success: true,
    apiKey: {
      id: created.id,
      token,
      name: created.name,
      teamId,
      ownerId,
      spendLimit,
      createdAt: created.created_at,
    },
  });
}
