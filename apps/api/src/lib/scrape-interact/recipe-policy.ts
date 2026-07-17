// ---------------------------------------------------------------------------
// Interact Recipes: command policy.
//
// A recipe is a minimal, versioned stream of agent-browser argv commands that
// re-runs a previously successful Interact prompt in a fresh session without a
// model. This module decides which commands are allowed to become recipe
// steps. The rules exist so that a recipe replayed later — or repaired by a
// model after drift — stays deterministic and side-effect-inspectable:
//
// - No session-specific `@eN` refs: they are minted per snapshot and do not
//   survive into a fresh session.
// - No positional selectors for actions: `:nth-child`-style targeting encodes
//   layout, not intent, and silently clicks the wrong element after drift.
// - No fixed-duration waits: they encode a machine's speed, not a page state.
// - No page mutation through eval: eval is the extraction step; mutations must
//   go through action commands so drift repair can reason about side effects.
// - No navigation (`open`): a recipe always starts from the session's start
//   state (scrape replay or the session's start URL), which the API controls.
// ---------------------------------------------------------------------------

export type RecipeCommand = string[];

export interface RecipeStep {
  id: number;
  args: RecipeCommand;
}

export interface RecipeRepairRecord {
  stepId: number;
  originalArgs: RecipeCommand;
  repairedArgs: RecipeCommand;
  failure: string;
  explanation: string;
  model: string;
  repairedAt: string;
}

export interface StoredRecipe {
  recipeId: string;
  version: number;
  teamId: string;
  prompt: string;
  model: string;
  createdAt: string;
  steps: RecipeStep[];
  /** Set on candidate versions produced by drift repair. */
  repairedFromVersion?: number;
  repairs?: RecipeRepairRecord[];
}

const allowedCommands = new Set([
  "click",
  "eval",
  "fill",
  "find",
  "press",
  "scroll",
  "select",
  "wait",
]);

const observationCommands = new Set(["get", "is", "snapshot"]);

const semanticLocators = new Set([
  "alt",
  "label",
  "placeholder",
  "role",
  "testid",
  "text",
  "title",
]);

const findActions = new Set([
  "check",
  "click",
  "fill",
  "focus",
  "hover",
  "type",
  "uncheck",
]);

// Infra-level agent-browser flags are owned by the execution layer, never by a
// recipe step (a stored --session or --cdp would cross session boundaries).
const forbiddenGlobalFlags = new Set([
  "--action-policy",
  "--allowed-domains",
  "--auto-connect",
  "--cdp",
  "--config",
  "--executable-path",
  "--extension",
  "--headed",
  "--init-script",
  "--namespace",
  "--profile",
  "--provider",
  "--proxy",
  "--session",
  "--state",
]);

/** True for commands that only observe the page and are never recipe steps. */
export function isObservationCommand(args: RecipeCommand): boolean {
  return observationCommands.has(args[0] ?? "");
}

/**
 * True when the command may change page state in a way that requires an
 * explicit state-based wait before the next command can rely on the page.
 */
export function requiresSynchronization(args: RecipeCommand): boolean {
  const command = args[0];
  return (
    command === "click" ||
    command === "press" ||
    command === "select" ||
    (command === "find" &&
      args.some(arg => ["click", "press", "select"].includes(arg)))
  );
}

/**
 * Validate one candidate recipe command. Throws with a model-correctable
 * message when the command cannot be part of a reusable recipe.
 */
export function validateRecipeCommand(args: RecipeCommand): void {
  const command = args[0];
  if (!command || !allowedCommands.has(command)) {
    if (isObservationCommand(args)) {
      throw new Error(
        `Observation command ${JSON.stringify(command)} cannot be a recipe step`,
      );
    }
    if (command === "open") {
      throw new Error(
        "Recipes cannot navigate; they start from the session's start state",
      );
    }
    throw new Error(
      `Command ${JSON.stringify(command)} is not allowed in a recipe`,
    );
  }
  if (args.some(arg => /^@e\d+$/.test(arg))) {
    throw new Error(
      "Session-specific @eN refs are not reusable; use a stable CSS selector",
    );
  }
  if (args.some(arg => forbiddenGlobalFlags.has(arg))) {
    throw new Error("Global agent-browser flags are controlled by the runtime");
  }
  if (command === "fill") {
    if (args.length !== 3) {
      throw new Error(
        'fill expects ["fill", "<CSS selector>", "<value>"]; use find label for a semantic label',
      );
    }
    if (semanticLocators.has(args[1] ?? "") || args[1] === "css") {
      throw new Error(
        'fill accepts a CSS selector directly; use ["find", "label", "<label>", "fill", "<value>"] for a field label',
      );
    }
  }
  if (command === "click") {
    const validNewTab = args.length === 3 && args[2] === "--new-tab";
    if ((args.length !== 2 && !validNewTab) || args[1] === "css") {
      throw new Error(
        'click expects ["click", "<CSS selector>"] with no locator prefix or flags',
      );
    }
  }
  if (command === "find") {
    const locator = args[1];
    const action = args[3];
    if (
      !locator ||
      !semanticLocators.has(locator) ||
      !args[2] ||
      !action ||
      !findActions.has(action)
    ) {
      throw new Error(
        'find expects ["find", "<label|role|placeholder|...>", "<locator value>", "<action>", ...]',
      );
    }
    if ((action === "fill" || action === "type") && !args[4]) {
      throw new Error(
        `find ${action} requires the value to enter after the action`,
      );
    }
    if (locator === "text" && action === "click") {
      throw new Error(
        "Plain text is ambiguous for controls; click by exact role/name or CSS",
      );
    }
  }
  if (command === "press" && args.length !== 2) {
    throw new Error('press expects one key, for example ["press", "Enter"]');
  }
  if (command === "wait") {
    if (args.length === 2 && /^\d+$/u.test(args[1] ?? "")) {
      throw new Error(
        "Fixed-duration waits are not reusable; wait for URL, load, text, or selector",
      );
    }
  }
  if (
    requiresSynchronization(args) &&
    args.some(arg => /:(?:first|last|nth)-(?:child|of-type)\b/u.test(arg))
  ) {
    throw new Error(
      "Positional selectors do not encode intent; target the control by identity",
    );
  }
  if (
    command === "eval" &&
    /(?:\blocation\s*=|\.click\s*\(|\.submit\s*\(|\brequestSubmit\s*\()/u.test(
      args.slice(1).join(" "),
    )
  ) {
    throw new Error(
      "eval is read-only; use an agent-browser action command to mutate the page",
    );
  }
}

/**
 * Validate a complete recipe step stream: every step passes the command
 * policy, the final step is a read-only eval extraction, and that eval is
 * preceded by an explicit state-based wait whenever any prior step could have
 * changed the page.
 */
export function validateRecipeSteps(steps: RecipeStep[]): void {
  if (steps.length === 0) {
    throw new Error("A recipe must contain at least one step");
  }
  for (const step of steps) {
    validateRecipeCommand(step.args);
  }
  const last = steps[steps.length - 1]!;
  if (last.args[0] !== "eval") {
    throw new Error(
      "A recipe must end with an eval step that extracts the result",
    );
  }
  const hasMutatingStep = steps.some(step =>
    requiresSynchronization(step.args),
  );
  if (hasMutatingStep) {
    const beforeLast = steps[steps.length - 2];
    if (!beforeLast || beforeLast.args[0] !== "wait") {
      throw new Error(
        "The final eval must follow an explicit wait when the recipe changes page state",
      );
    }
  }
}

/**
 * A step failure is repairable only when the error proves the command did not
 * execute (for example, its selector matched nothing). Anything that may have
 * had a side effect stops the run instead of risking a duplicate action.
 */
export function isProvablySafeToRepair(
  args: RecipeCommand,
  error: unknown,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const command =
    args[0] !== "find"
      ? args[0]
      : ["fill", "click", "select", "press"].find(action =>
          args.includes(action),
        );

  if (command === "fill" || command === "click" || command === "select") {
    return /element not found|no element found|selector.+not found|unknown subaction|invalid command|usage:/iu.test(
      message,
    );
  }
  if (command === "wait") return /timed out|timeout|not found/iu.test(message);
  if (command === "eval") return true;
  return false;
}
