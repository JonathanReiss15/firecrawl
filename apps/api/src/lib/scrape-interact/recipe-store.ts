import { randomUUID } from "crypto";
import { redisEvictConnection } from "../../services/redis";
import type { StoredRecipe } from "./recipe-policy";

// ---------------------------------------------------------------------------
// Interact Recipes: storage.
//
// Recipes are stored in Redis, keyed by team + recipeId + version, with a
// long retention window. A recipe is a re-learnable artifact — if one ever
// expires, the next `recipe: { mode: "learn" }` call re-derives it from the
// prompt — so Redis retention is acceptable for the initial release. Durable
// Postgres storage (mirroring browser_sessions' dual-store pattern) is the
// follow-up for long-lived production pins.
// ---------------------------------------------------------------------------

const RECIPE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const recipeKey = (teamId: string, recipeId: string, version: number) =>
  `interact_recipe:${teamId}:${recipeId}:v${version}`;
const latestVersionKey = (teamId: string, recipeId: string) =>
  `interact_recipe:${teamId}:${recipeId}:latest`;

export function newRecipeId(): string {
  return `rcp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function saveRecipe(recipe: StoredRecipe): Promise<void> {
  const key = recipeKey(recipe.teamId, recipe.recipeId, recipe.version);
  const latestKey = latestVersionKey(recipe.teamId, recipe.recipeId);
  await redisEvictConnection
    .multi()
    .set(key, JSON.stringify(recipe), "EX", RECIPE_RETENTION_SECONDS)
    .set(latestKey, String(recipe.version), "EX", RECIPE_RETENTION_SECONDS)
    .exec();
}

/**
 * Persist a repaired variant of a pinned recipe as the next version without
 * touching the pinned version. Returns the candidate's version number.
 */
export async function saveCandidateRecipe(
  base: StoredRecipe,
  candidate: Omit<StoredRecipe, "version">,
): Promise<number> {
  const latestRaw = await redisEvictConnection.get(
    latestVersionKey(base.teamId, base.recipeId),
  );
  const latest = Number(latestRaw ?? base.version);
  const version = (Number.isFinite(latest) ? latest : base.version) + 1;
  await saveRecipe({ ...candidate, version });
  return version;
}

export async function getRecipe(
  teamId: string,
  recipeId: string,
  version: number,
): Promise<StoredRecipe | null> {
  const raw = await redisEvictConnection.get(
    recipeKey(teamId, recipeId, version),
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredRecipe;
  } catch {
    return null;
  }
}
