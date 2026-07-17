import { z } from "zod";
import { logger as _logger } from "../logger";
import {
  learnRecipeViaPrompt,
  executeRecipeSteps,
  RecipeStepError,
} from "./recipe-runner";
import { getRecipe, saveCandidateRecipe } from "./recipe-store";
import type { RecipeStep, StoredRecipe } from "./recipe-policy";

// ---------------------------------------------------------------------------
// Interact Recipes: request/response contract shared by the standalone
// (/v2/{browser,interact}/:sessionId/execute) and scrape-bound
// (/v2/scrape/:jobId/interact) controllers.
// ---------------------------------------------------------------------------

export const recipeRequestSchema = z.union([
  z.object({
    mode: z.literal("learn"),
    includeSteps: z.boolean().default(false),
  }),
  z.object({
    recipeId: z.string().min(1),
    version: z.number().int().positive(),
    onDrift: z.enum(["fail", "repair-safe"]).default("fail"),
    includeSteps: z.boolean().default(false),
  }),
]);

type RecipeRequest = z.infer<typeof recipeRequestSchema>;

export interface RecipeResponseMetadata {
  recipeId: string;
  version: number;
  route: "learned" | "executed" | "repaired";
  candidateVersion?: number;
  steps?: RecipeStep[];
  repair?: {
    step: number;
    from: string[];
    to: string[];
  };
}

type RecipeRunOutcome =
  | {
      ok: true;
      /** Model narration (learn) or empty (deterministic execution). */
      output: string;
      /** JSON-stringified extraction result. */
      result: string;
      stdout: string;
      /** True when a model ran (learn or repair) — bills at the prompt rate. */
      usedModel: boolean;
      recipe: RecipeResponseMetadata;
    }
  | {
      ok: false;
      status: 200 | 404;
      error: string;
      usedModel: boolean;
    };

export function isLearnRequest(
  recipe: RecipeRequest,
): recipe is Extract<RecipeRequest, { mode: "learn" }> {
  return "mode" in recipe;
}

/**
 * Run a recipe request (learn or pinned execution) against a live browser
 * session. Failures that reflect the recipe/page (drift, unsafe repair,
 * non-converging learn) return `ok: false` with HTTP 200 semantics, matching
 * how failed code executions are reported; only a missing pinned recipe is a
 * 404.
 */
export async function runRecipeRequest(options: {
  recipe: RecipeRequest;
  prompt: string | undefined;
  browserId: string;
  teamId: string;
  stepTimeout: number;
  logger: typeof _logger;
}): Promise<RecipeRunOutcome> {
  const { recipe, prompt, browserId, teamId, stepTimeout, logger } = options;

  if (isLearnRequest(recipe)) {
    try {
      const learned = await learnRecipeViaPrompt({
        prompt: prompt!,
        browserId,
        teamId,
        stepTimeout,
        logger,
      });
      return {
        ok: true,
        output: learned.agentText,
        result: JSON.stringify(learned.result),
        stdout: learned.stdout,
        usedModel: true,
        recipe: {
          recipeId: learned.recipe.recipeId,
          version: learned.recipe.version,
          route: "learned",
          ...(recipe.includeSteps ? { steps: learned.recipe.steps } : {}),
        },
      };
    } catch (error) {
      logger.warn("Recipe learn failed", { error });
      return {
        ok: false,
        status: 200,
        error:
          error instanceof Error
            ? `Recipe learn failed: ${error.message}`
            : "Recipe learn failed.",
        usedModel: true,
      };
    }
  }

  const stored: StoredRecipe | null = await getRecipe(
    teamId,
    recipe.recipeId,
    recipe.version,
  );
  if (!stored) {
    return {
      ok: false,
      status: 404,
      error: `Recipe ${recipe.recipeId} v${recipe.version} not found.`,
      usedModel: false,
    };
  }

  try {
    const execution = await executeRecipeSteps({
      recipe: stored,
      browserId,
      stepTimeout,
      onDrift: recipe.onDrift,
      prompt,
      logger,
    });

    if (execution.repairs.length === 0) {
      return {
        ok: true,
        output: "",
        result: JSON.stringify(execution.result),
        stdout: execution.stdout,
        usedModel: false,
        recipe: {
          recipeId: stored.recipeId,
          version: stored.version,
          route: "executed",
          ...(recipe.includeSteps ? { steps: execution.steps } : {}),
        },
      };
    }

    // A verified repair becomes a candidate version; the pinned version is
    // never modified in place.
    const candidateVersion = await saveCandidateRecipe(stored, {
      recipeId: stored.recipeId,
      teamId: stored.teamId,
      prompt: stored.prompt,
      model: stored.model,
      createdAt: new Date().toISOString(),
      steps: execution.steps,
      repairedFromVersion: stored.version,
      repairs: execution.repairs,
    });
    const firstRepair = execution.repairs[0]!;
    return {
      ok: true,
      output: "",
      result: JSON.stringify(execution.result),
      stdout: execution.stdout,
      usedModel: true,
      recipe: {
        recipeId: stored.recipeId,
        version: stored.version,
        route: "repaired",
        candidateVersion,
        ...(recipe.includeSteps ? { steps: execution.steps } : {}),
        repair: {
          step: firstRepair.stepId,
          from: firstRepair.originalArgs,
          to: firstRepair.repairedArgs,
        },
      },
    };
  } catch (error) {
    const usedModel = recipe.onDrift === "repair-safe";
    logger.warn("Recipe execution failed", { error });
    return {
      ok: false,
      status: 200,
      error:
        error instanceof RecipeStepError || error instanceof Error
          ? error.message
          : "Recipe execution failed.",
      usedModel,
    };
  }
}
