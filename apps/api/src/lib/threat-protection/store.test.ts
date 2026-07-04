import { resolveEffectivePolicy, OrgThreatProtectionConfig } from "./store";
import {
  THREAT_PROTECTION_POLICY_DEFAULTS,
  ThreatProtectionPolicy,
} from "./types";

const orgPolicy: ThreatProtectionPolicy = {
  mode: "enhanced",
  riskScoreThreshold: 60,
  deniedCategories: ["Malicious", "Phishing"],
  maxDomainAgeDays: 30,
  blacklist: ["*.bad.example"],
  whitelist: ["example.com"],
  blockedTlds: ["zip"],
  blockedCountries: ["KP"],
  failurePolicy: "open",
};

function makeOrgConfig(
  overrides: Partial<OrgThreatProtectionConfig> = {},
): OrgThreatProtectionConfig {
  return {
    orgId: "00000000-0000-0000-0000-000000000000",
    policy: { ...orgPolicy },
    allowRequestOverrides: true,
    siem: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("resolveEffectivePolicy", () => {
  it("returns mode off with defaults when there is no org config", () => {
    expect(resolveEffectivePolicy(null)).toEqual({
      mode: "off",
      ...THREAT_PROTECTION_POLICY_DEFAULTS,
    });
  });

  it("returns the org policy when there is no request override", () => {
    expect(resolveEffectivePolicy(makeOrgConfig())).toEqual(orgPolicy);
  });

  it("does field-level replacement from the request override", () => {
    const effective = resolveEffectivePolicy(makeOrgConfig(), {
      riskScoreThreshold: 90,
      blockedTlds: ["mov"],
    });
    expect(effective).toEqual({
      ...orgPolicy,
      riskScoreThreshold: 90,
      blockedTlds: ["mov"],
    });
  });

  it("replaces arrays wholesale instead of merging them", () => {
    const effective = resolveEffectivePolicy(makeOrgConfig(), {
      blacklist: ["*.other.example"],
    });
    expect(effective.blacklist).toEqual(["*.other.example"]);
  });

  it("ignores undefined fields in the override", () => {
    const effective = resolveEffectivePolicy(makeOrgConfig(), {
      riskScoreThreshold: undefined,
      failurePolicy: "closed",
    });
    expect(effective.riskScoreThreshold).toBe(60);
    expect(effective.failurePolicy).toBe("closed");
  });

  it("applies overrides on top of defaults when there is no org config", () => {
    const effective = resolveEffectivePolicy(null, {
      mode: "normal",
      riskScoreThreshold: 10,
    });
    expect(effective).toEqual({
      mode: "normal",
      ...THREAT_PROTECTION_POLICY_DEFAULTS,
      riskScoreThreshold: 10,
    });
  });

  it("ignores the override when the org disables request overrides", () => {
    const effective = resolveEffectivePolicy(
      makeOrgConfig({ allowRequestOverrides: false }),
      { mode: "off", riskScoreThreshold: 0 },
    );
    expect(effective).toEqual(orgPolicy);
  });

  it("does not mutate the org config", () => {
    const orgConfig = makeOrgConfig();
    resolveEffectivePolicy(orgConfig, { riskScoreThreshold: 1 });
    expect(orgConfig.policy).toEqual(orgPolicy);
  });
});
