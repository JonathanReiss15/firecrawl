import { z } from "zod";
import { tool, stepCountIs } from "ai";
import { logger as _logger } from "../logger";
import { config } from "../../config";
import { getModel } from "../generic-ai";
import {
  browserServiceRequest,
  BrowserServiceExecResponse,
} from "./browser-service-client";
import { generateText, generateObject } from "./langsmith";
import {
  isObservationCommand,
  isProvablySafeToRepair,
  requiresSynchronization,
  validateRecipeCommand,
  validateRecipeSteps,
  type RecipeCommand,
  type RecipeRepairRecord,
  type RecipeStep,
  type StoredRecipe,
} from "./recipe-policy";
import { newRecipeId, saveRecipe } from "./recipe-store";

// ---------------------------------------------------------------------------
// Interact Recipes: learn / execute / repair.
//
// Learn: a prompt run drives the browser through a strict argv-only tool.
// Every successful non-observation command becomes a candidate step; the
// model finishes by selecting the minimal ordered subset that solves the
// task. The selection is validated by the recipe policy and persisted.
//
// Execute: a pinned recipe's steps run against the session's agent-browser
// with no model involved. The final eval's JSON output is the result.
//
// Repair: when a pinned step fails in a provably side-effect-free way and the
// caller opted into `onDrift: "repair-safe"`, a model proposes one same-kind
// replacement from live page evidence. A successful repair is returned as a
// candidate version; the pinned recipe is never silently modified.
// ---------------------------------------------------------------------------

const MAX_LEARN_STEPS = 30;
const MAX_REPAIR_ATTEMPTS = 2;
const OBSERVATION_MAX_CHARS = 20_000;

const INTERACTIVE_ELEMENT_INVENTORY_JS = `JSON.stringify(Array.from(document.querySelectorAll('input,button,a,select,textarea,[role]')).map(function (element) { return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), text: (element.textContent || '').trim().slice(0, 120), id: element.id || null, name: element.getAttribute('name'), type: element.getAttribute('type'), ariaLabel: element.getAttribute('aria-label'), placeholder: element.getAttribute('placeholder') }; }).filter(function (item) { return item.id || item.name || item.text || item.ariaLabel || item.placeholder; }).slice(0, 200))`;

function getRecipeModel() {
  return getModel(
    config.INTERACT_MODEL_NAME ?? "gemini-3.5-flash",
    (config.INTERACT_MODEL_PROVIDER ?? "google") as Parameters<
      typeof getModel
    >[1],
  );
}

function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

function agentBrowserCommand(args: RecipeCommand): string {
  return `agent-browser ${args.map(shellQuote).join(" ")}`;
}

export class RecipeStepError extends Error {
  constructor(
    readonly step: RecipeStep,
    message: string,
  ) {
    super(message);
  }
}

async function execAgentBrowser(
  browserId: string,
  args: RecipeCommand,
  timeoutSeconds: number,
  origin: string,
): Promise<string> {
  const result = await browserServiceRequest<BrowserServiceExecResponse>(
    "POST",
    `/browsers/${browserId}/exec`,
    {
      code: agentBrowserCommand(args),
      language: "bash",
      timeout: timeoutSeconds,
      origin,
    },
  );
  if (result.exitCode !== 0 || result.killed) {
    throw new Error(
      (result.stderr || result.stdout || "agent-browser command failed").trim(),
    );
  }
  return (result.stdout || "").trim();
}

/**
 * agent-browser eval prints the evaluated value JSON-encoded; recipes are
 * required to return a JSON string from eval, so the payload is often
 * double-encoded. Parse one layer, then a second when the first yields a
 * string.
 */
function parseEvalOutput(raw: string): unknown {
  let value: unknown = JSON.parse(raw);
  if (typeof value === "string") value = JSON.parse(value);
  return value;
}

// ---------------------------------------------------------------------------
// Learn
// ---------------------------------------------------------------------------

const LEARN_SYSTEM_PROMPT = `You are teaching a reusable browser recipe. You are already on the target page — never navigate away from it.

Use run_command for every browser operation. Pass exact agent-browser argv tokens. Only these forms are allowed:
- ["snapshot", "-i"] (observation, not part of the recipe)
- ["get", "url"] or ["get", "title"] (observation)
- ["fill", "<CSS selector>", "<value required by the task>"]
- ["click", "<CSS selector>"]
- ["find", "label", "<exact field label>", "fill", "<value required by the task>"]
- ["press", "<key>"]
- ["select", "<CSS selector>", "<option>"]
- ["wait", "--load", "networkidle"] or ["wait", "--url", "<glob>"] or ["wait", "--text", "<text>"] or ["wait", "<CSS selector>"]
- ["eval", "<read-only JavaScript returning JSON.stringify(...)>"]

Rules:
- Never use session-specific @eN refs in actions; they do not survive into a fresh session. Inspect ids, names, and types via snapshot or read-only eval, then use stable CSS selectors.
- The field label identifies where to type; it is never the value to type.
- After a click or keypress that changes the page, run an explicit state-based wait before anything else. Fixed-duration waits are rejected.
- eval is read-only: extract with it, never click, submit, or navigate through it.
- The final command must be eval returning exactly the JSON the task asks for, as JSON.stringify(...).

Successful non-observation commands are reported back with candidate step IDs. When the task is complete, call finish with only the ordered candidate step IDs that form the minimal successful path — exclude failed attempts, redundant actions, and exploratory eval calls. The selection must end with the final extraction eval. After finish succeeds, reply with a one-sentence summary of the result.`;

interface LearnedRecipeRun {
  recipe: StoredRecipe;
  result: unknown;
  agentText: string;
  stdout: string;
}

export async function learnRecipeViaPrompt(options: {
  prompt: string;
  browserId: string;
  teamId: string;
  stepTimeout: number;
  logger: typeof _logger;
}): Promise<LearnedRecipeRun> {
  const { prompt, browserId, teamId, stepTimeout, logger } = options;
  const model = getRecipeModel();

  interface Candidate {
    id: number;
    args: RecipeCommand;
    output: string;
  }
  const candidates: Candidate[] = [];
  const allOutputs: string[] = [];
  let awaitingSynchronization = false;
  let selected: Candidate[] | null = null;

  const runCommandTool = tool({
    description:
      "Run one agent-browser command as exact argv tokens (without the executable).",
    inputSchema: z.object({
      args: z
        .array(z.string())
        .min(1)
        .describe(
          'Exact agent-browser argv, e.g. ["fill", "#q", "value"] or ["wait", "--url", "*q=value*"].',
        ),
    }),
    execute: async ({ args }) => {
      const observation = isObservationCommand(args);
      try {
        if (!observation) validateRecipeCommand(args);
        if (awaitingSynchronization && args[0] !== "wait") {
          throw new Error(
            "The previous action may have changed the page; run a specific wait before another command",
          );
        }
        const output = await execAgentBrowser(
          browserId,
          args,
          stepTimeout,
          "recipe_learn",
        );
        if (args[0] === "wait") awaitingSynchronization = false;
        if (requiresSynchronization(args)) awaitingSynchronization = true;

        const clipped = output.slice(0, OBSERVATION_MAX_CHARS);
        if (observation) return { result: clipped || "(no output)" };

        const candidate: Candidate = {
          id: candidates.length + 1,
          args,
          output,
        };
        candidates.push(candidate);
        if (output) allOutputs.push(output);
        logger.info("Recipe learn: candidate step", {
          stepId: candidate.id,
          args,
        });
        return {
          result: `Candidate recipe step ${candidate.id} succeeded.\n${clipped}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.info("Recipe learn: command rejected or failed", {
          args,
          error: message,
        });
        return { error: `Command rejected or failed: ${message}` };
      }
    },
  });

  const finishTool = tool({
    description:
      "Select the ordered candidate step IDs that form the minimal successful recipe.",
    inputSchema: z.object({
      stepIds: z.array(z.number().int().positive()).min(1),
    }),
    execute: async ({ stepIds }) => {
      try {
        if (new Set(stepIds).size !== stepIds.length) {
          throw new Error("step IDs must be unique");
        }
        const chosen = stepIds.map(id => {
          const step = candidates.find(candidate => candidate.id === id);
          if (!step) throw new Error(`unknown candidate step ${id}`);
          return step;
        });
        if (
          chosen.some(
            (step, index) => index > 0 && step.id <= chosen[index - 1]!.id,
          )
        ) {
          throw new Error("step IDs must preserve execution order");
        }
        validateRecipeSteps(
          chosen.map((step, index) => ({ id: index + 1, args: step.args })),
        );
        // The final eval must parse as JSON before the recipe is accepted.
        parseEvalOutput(chosen[chosen.length - 1]!.output);
        selected = chosen;
        return { result: "Recipe accepted." };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Cannot finish: ${message}` };
      }
    },
  });

  const generation = await generateText({
    model,
    system: LEARN_SYSTEM_PROMPT,
    prompt: `Task: ${prompt}`,
    tools: { run_command: runCommandTool, finish: finishTool },
    stopWhen: [stepCountIs(MAX_LEARN_STEPS), () => selected !== null],
  });

  if (!selected) {
    throw new Error(
      "The model did not converge on a valid recipe for this prompt.",
    );
  }
  const chosen: Candidate[] = selected;

  const steps: RecipeStep[] = chosen.map((step, index) => ({
    id: index + 1,
    args: step.args,
  }));
  const finalOutput = chosen[chosen.length - 1]!.output;
  const result = parseEvalOutput(finalOutput);

  const recipe: StoredRecipe = {
    recipeId: newRecipeId(),
    version: 1,
    teamId,
    prompt,
    model: config.INTERACT_MODEL_NAME ?? "gemini-3.5-flash",
    createdAt: new Date().toISOString(),
    steps,
  };
  await saveRecipe(recipe);
  logger.info("Recipe learned", {
    recipeId: recipe.recipeId,
    steps: steps.length,
  });

  return {
    recipe,
    result,
    agentText: generation.text || "",
    stdout: allOutputs.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Execute (+ repair)
// ---------------------------------------------------------------------------

interface RecipeExecutionRun {
  result: unknown;
  stdout: string;
  steps: RecipeStep[];
  repairs: RecipeRepairRecord[];
}

const repairProposalSchema = z.object({
  args: z.array(z.string()).min(1),
  explanation: z.string().min(1),
});

function commandKind(args: RecipeCommand): string | undefined {
  if (args[0] !== "find") return args[0];
  return ["fill", "click", "select", "press"].find(action =>
    args.includes(action),
  );
}

async function proposeStepRepair(options: {
  browserId: string;
  prompt: string;
  step: RecipeStep;
  failure: string;
  stepTimeout: number;
  rejectedArgs: RecipeCommand[];
}): Promise<{ args: RecipeCommand; explanation: string }> {
  const { browserId, prompt, step, failure, stepTimeout, rejectedArgs } =
    options;

  const snapshot = await execAgentBrowser(
    browserId,
    ["snapshot", "-i"],
    stepTimeout,
    "recipe_repair_evidence",
  ).catch(() => "");
  const inventory = await execAgentBrowser(
    browserId,
    ["eval", INTERACTIVE_ELEMENT_INVENTORY_JS],
    stepTimeout,
    "recipe_repair_evidence",
  ).catch(() => "");

  const { object } = await generateObject({
    model: getRecipeModel(),
    schema: repairProposalSchema,
    system: `Repair one failed agent-browser recipe step.

Return exactly one replacement command with the same action kind as the failed command. A direct fill may become a semantic label fill, and vice versa. Clicks must use a stable CSS selector from the DOM evidence.

Valid argv forms include:
- ["fill", "<css selector>", "<value>"]
- ["click", "<css selector>"]
- ["find", "label", "<label>", "fill", "<value>"]

Change only what is needed to recover the task's original intent. Prefer an exact stable CSS attribute from the DOM inventory when one exists; otherwise use a role/name or label supported by the evidence. Never use session-specific @eN refs, invented selector syntax, positional selectors, shell syntax, credentials, another domain, or eval to mutate the page. Do not add exploratory commands.`,
    prompt: `Task: ${prompt}
Failed step: ${step.id}
Failed argv: ${JSON.stringify(step.args)}
Failure: ${failure}
Rejected repairs from earlier attempts: ${JSON.stringify(rejectedArgs)}

Accessibility snapshot:
${snapshot.slice(0, OBSERVATION_MAX_CHARS)}

DOM inventory:
${inventory.slice(0, OBSERVATION_MAX_CHARS)}`,
  });

  if (commandKind(object.args) !== commandKind(step.args)) {
    throw new Error(
      `Repair changed command kind from ${JSON.stringify(commandKind(step.args))} to ${JSON.stringify(commandKind(object.args))}`,
    );
  }
  if (JSON.stringify(object.args) === JSON.stringify(step.args)) {
    throw new Error("Repair returned the same failed command");
  }
  validateRecipeCommand(object.args);
  return object;
}

export async function executeRecipeSteps(options: {
  recipe: StoredRecipe;
  browserId: string;
  stepTimeout: number;
  onDrift: "fail" | "repair-safe";
  /** Original task prompt; used only as repair context. */
  prompt?: string;
  logger: typeof _logger;
}): Promise<RecipeExecutionRun> {
  const { recipe, browserId, stepTimeout, onDrift, logger } = options;
  const repairPrompt = options.prompt || recipe.prompt;

  const workingSteps: RecipeStep[] = recipe.steps.map(step => ({
    id: step.id,
    args: [...step.args],
  }));
  const repairs: RecipeRepairRecord[] = [];
  const outputs: string[] = [];
  let lastOutput = "";

  for (const step of workingSteps) {
    try {
      lastOutput = await execAgentBrowser(
        browserId,
        step.args,
        stepTimeout,
        "recipe_execute",
      );
      logger.info("Recipe step executed", { stepId: step.id, args: step.args });
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      if (onDrift !== "repair-safe") {
        throw new RecipeStepError(
          step,
          `Recipe step ${step.id} failed: ${failure}`,
        );
      }
      if (!isProvablySafeToRepair(step.args, failure)) {
        throw new RecipeStepError(
          step,
          `Recipe step ${step.id} failed and cannot be safely repaired (the failure does not prove the command had no side effect): ${failure}`,
        );
      }

      let repaired = false;
      const rejectedArgs: RecipeCommand[] = [];
      let currentFailure = failure;
      let currentArgs = step.args;
      for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
        const proposal = await proposeStepRepair({
          browserId,
          prompt: repairPrompt,
          step: { id: step.id, args: currentArgs },
          failure: currentFailure,
          stepTimeout,
          rejectedArgs,
        });
        try {
          lastOutput = await execAgentBrowser(
            browserId,
            proposal.args,
            stepTimeout,
            "recipe_repair",
          );
          repairs.push({
            stepId: step.id,
            originalArgs: [...step.args],
            repairedArgs: proposal.args,
            failure: failure.slice(0, 1_000),
            explanation: proposal.explanation,
            model: config.INTERACT_MODEL_NAME ?? "gemini-3.5-flash",
            repairedAt: new Date().toISOString(),
          });
          step.args = proposal.args;
          repaired = true;
          logger.info("Recipe step repaired", {
            stepId: step.id,
            args: proposal.args,
          });
          break;
        } catch (repairError) {
          rejectedArgs.push(proposal.args);
          currentArgs = proposal.args;
          currentFailure =
            repairError instanceof Error
              ? repairError.message
              : String(repairError);
        }
      }
      if (!repaired) {
        throw new RecipeStepError(
          step,
          `Recipe step ${step.id} exceeded ${MAX_REPAIR_ATTEMPTS} repair attempts: ${currentFailure}`,
        );
      }
    }
    if (lastOutput) outputs.push(lastOutput);
  }

  let result: unknown;
  try {
    result = parseEvalOutput(lastOutput);
  } catch (error) {
    throw new Error(
      `Recipe executed but the final eval did not return valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { result, stdout: outputs.join("\n"), steps: workingSteps, repairs };
}
