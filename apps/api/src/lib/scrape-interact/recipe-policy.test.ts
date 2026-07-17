import { describe, expect, it } from "vitest";
import {
  isObservationCommand,
  isProvablySafeToRepair,
  requiresSynchronization,
  validateRecipeCommand,
  validateRecipeSteps,
  type RecipeStep,
} from "./recipe-policy";

describe("validateRecipeCommand", () => {
  it("accepts the core reusable action forms", () => {
    expect(() =>
      validateRecipeCommand(["fill", "#q", "Nashville Predators"]),
    ).not.toThrow();
    expect(() =>
      validateRecipeCommand(["click", 'input[type="submit"]']),
    ).not.toThrow();
    expect(() =>
      validateRecipeCommand([
        "find",
        "label",
        "Search for Teams:",
        "fill",
        "x",
      ]),
    ).not.toThrow();
    expect(() => validateRecipeCommand(["press", "Enter"])).not.toThrow();
    expect(() =>
      validateRecipeCommand(["wait", "--url", "*q=Nashville*"]),
    ).not.toThrow();
    expect(() =>
      validateRecipeCommand(["wait", "--load", "networkidle"]),
    ).not.toThrow();
    expect(() =>
      validateRecipeCommand([
        "eval",
        "JSON.stringify([...document.querySelectorAll('tr')].length)",
      ]),
    ).not.toThrow();
  });

  it("rejects session-specific @eN refs", () => {
    expect(() => validateRecipeCommand(["click", "@e12"])).toThrow(/@eN refs/);
    expect(() => validateRecipeCommand(["fill", "@e3", "value"])).toThrow(
      /@eN refs/,
    );
  });

  it("rejects navigation", () => {
    expect(() =>
      validateRecipeCommand(["open", "https://example.com"]),
    ).toThrow(/cannot navigate/);
  });

  it("rejects observation commands as steps", () => {
    expect(() => validateRecipeCommand(["snapshot", "-i"])).toThrow(
      /cannot be a recipe step/,
    );
    expect(() => validateRecipeCommand(["get", "url"])).toThrow(
      /cannot be a recipe step/,
    );
  });

  it("rejects fixed-duration waits", () => {
    expect(() => validateRecipeCommand(["wait", "2000"])).toThrow(
      /Fixed-duration/,
    );
  });

  it("rejects positional selectors on synchronizing actions", () => {
    expect(() =>
      validateRecipeCommand(["click", "table tr:nth-child(3) a"]),
    ).toThrow(/Positional selectors/);
  });

  it("rejects page mutation through eval", () => {
    expect(() =>
      validateRecipeCommand(["eval", "document.forms[0].submit()"]),
    ).toThrow(/read-only/);
    expect(() =>
      validateRecipeCommand(["eval", "document.querySelector('a').click()"]),
    ).toThrow(/read-only/);
    expect(() => validateRecipeCommand(["eval", "location = '/next'"])).toThrow(
      /read-only/,
    );
  });

  it("rejects infra-level global flags", () => {
    expect(() =>
      validateRecipeCommand(["click", "#go", "--session", "other"]),
    ).toThrow(/controlled by the runtime/);
    expect(() => validateRecipeCommand(["fill", "--cdp", "9222"])).toThrow(
      /controlled by the runtime/,
    );
  });

  it("rejects ambiguous text clicks through find", () => {
    expect(() =>
      validateRecipeCommand(["find", "text", "Submit", "click"]),
    ).toThrow(/ambiguous/);
  });

  it("rejects malformed fill/click/press shapes", () => {
    expect(() => validateRecipeCommand(["fill", "#q"])).toThrow(/fill expects/);
    expect(() => validateRecipeCommand(["fill", "label", "Search"])).toThrow(
      /find.*label/,
    );
    expect(() => validateRecipeCommand(["click"])).toThrow(/click expects/);
    expect(() => validateRecipeCommand(["press", "a", "b"])).toThrow(
      /press expects/,
    );
  });
});

describe("validateRecipeSteps", () => {
  const step = (id: number, args: string[]): RecipeStep => ({ id, args });

  it("accepts a full interaction stream ending in wait + eval", () => {
    expect(() =>
      validateRecipeSteps([
        step(1, ["fill", "#q", "Nashville Predators"]),
        step(2, ["click", 'input[type="submit"]']),
        step(3, ["wait", "--url", "*q=Nashville*"]),
        step(4, ["eval", "JSON.stringify(1)"]),
      ]),
    ).not.toThrow();
  });

  it("accepts a pure extraction recipe without a wait", () => {
    expect(() =>
      validateRecipeSteps([step(1, ["eval", "JSON.stringify(1)"])]),
    ).not.toThrow();
  });

  it("rejects an empty recipe", () => {
    expect(() => validateRecipeSteps([])).toThrow(/at least one step/);
  });

  it("rejects a recipe that does not end in eval", () => {
    expect(() => validateRecipeSteps([step(1, ["click", "#go"])])).toThrow(
      /end with an eval/,
    );
  });

  it("rejects a mutating recipe whose eval does not follow a wait", () => {
    expect(() =>
      validateRecipeSteps([
        step(1, ["click", "#go"]),
        step(2, ["eval", "JSON.stringify(1)"]),
      ]),
    ).toThrow(/must follow an explicit wait/);
  });
});

describe("requiresSynchronization / isObservationCommand", () => {
  it("classifies mutating vs. observing commands", () => {
    expect(requiresSynchronization(["click", "#go"])).toBe(true);
    expect(requiresSynchronization(["press", "Enter"])).toBe(true);
    expect(requiresSynchronization(["find", "label", "X", "click"])).toBe(true);
    expect(requiresSynchronization(["fill", "#q", "x"])).toBe(false);
    expect(isObservationCommand(["snapshot", "-i"])).toBe(true);
    expect(isObservationCommand(["get", "url"])).toBe(true);
    expect(isObservationCommand(["eval", "1"])).toBe(false);
  });
});

describe("isProvablySafeToRepair", () => {
  it("allows repair when the error proves the action did not run", () => {
    expect(
      isProvablySafeToRepair(
        ["fill", "input[name='gone']", "x"],
        new Error("Element not found: input[name='gone']"),
      ),
    ).toBe(true);
    expect(
      isProvablySafeToRepair(
        ["click", "#missing"],
        new Error("No element found for selector #missing"),
      ),
    ).toBe(true);
    expect(
      isProvablySafeToRepair(
        ["wait", "--url", "*q=*"],
        new Error("Timed out waiting for URL"),
      ),
    ).toBe(true);
    expect(
      isProvablySafeToRepair(["eval", "JSON.stringify(1)"], new Error("boom")),
    ).toBe(true);
  });

  it("refuses repair when a side effect cannot be ruled out", () => {
    expect(
      isProvablySafeToRepair(
        ["click", "#buy"],
        new Error("Navigation aborted"),
      ),
    ).toBe(false);
    expect(
      isProvablySafeToRepair(
        ["press", "Enter"],
        new Error("Element not found"),
      ),
    ).toBe(false);
  });
});
