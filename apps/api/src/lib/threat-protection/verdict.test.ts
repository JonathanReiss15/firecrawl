import {
  RawVerdict,
  THREAT_PROTECTION_POLICY_DEFAULTS,
  ThreatDecisionRule,
  ThreatProtectionPolicy,
} from "./types";
import { evaluatePolicy, localOnlyDecision, normalizeDomain } from "./verdict";

function policy(
  overrides: Partial<ThreatProtectionPolicy> = {},
): ThreatProtectionPolicy {
  return {
    mode: "enhanced",
    ...THREAT_PROTECTION_POLICY_DEFAULTS,
    ...overrides,
  };
}

function verdict(overrides: Partial<RawVerdict> = {}): RawVerdict {
  return {
    provider: "alphamountain",
    riskScore: 0,
    categories: [],
    domainAgeDays: null,
    countryCode: null,
    fromCache: false,
    raw: {},
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  type Case = {
    name: string;
    domain: string;
    verdict: RawVerdict | null;
    policy: ThreatProtectionPolicy;
    allowed: boolean;
    rule: ThreatDecisionRule;
  };

  const cases: Case[] = [
    // --- whitelist ---
    {
      name: "whitelist exact match allows",
      domain: "example.com",
      verdict: verdict(),
      policy: policy({ whitelist: ["example.com"] }),
      allowed: true,
      rule: "whitelist",
    },
    {
      name: "whitelist exact entry also matches subdomains",
      domain: "deep.sub.example.com",
      verdict: verdict(),
      policy: policy({ whitelist: ["example.com"] }),
      allowed: true,
      rule: "whitelist",
    },
    {
      name: "whitelist glob matches multi-label subdomains",
      domain: "a.b.example.com",
      verdict: verdict(),
      policy: policy({ whitelist: ["*.example.com"] }),
      allowed: true,
      rule: "whitelist",
    },
    {
      name: "whitelist glob does not match the apex domain",
      domain: "example.com",
      verdict: verdict({ riskScore: 100 }),
      policy: policy({ whitelist: ["*.example.com"] }),
      allowed: false,
      rule: "risk-score",
    },
    {
      name: "whitelist entries are case-insensitive",
      domain: "example.com",
      verdict: verdict(),
      policy: policy({ whitelist: ["EXAMPLE.com"] }),
      allowed: true,
      rule: "whitelist",
    },
    {
      name: "whitelist does not match unrelated suffix (notexample.com)",
      domain: "notexample.com",
      verdict: verdict({ riskScore: 100 }),
      policy: policy({ whitelist: ["example.com"] }),
      allowed: false,
      rule: "risk-score",
    },
    // --- whitelist precedence: wins over everything ---
    {
      name: "whitelist wins over blacklist",
      domain: "example.com",
      verdict: verdict(),
      policy: policy({
        whitelist: ["example.com"],
        blacklist: ["example.com"],
      }),
      allowed: true,
      rule: "whitelist",
    },
    {
      name: "whitelist wins over blocked TLD",
      domain: "good.zip",
      verdict: verdict(),
      policy: policy({ whitelist: ["good.zip"], blockedTlds: ["zip"] }),
      allowed: true,
      rule: "whitelist",
    },
    {
      name: "whitelist wins over a maximally risky verdict",
      domain: "example.com",
      verdict: verdict({
        riskScore: 100,
        categories: ["Malicious"],
        domainAgeDays: 1,
        countryCode: "KP",
      }),
      policy: policy({
        whitelist: ["example.com"],
        deniedCategories: ["Malicious"],
        maxDomainAgeDays: 30,
        blockedCountries: ["KP"],
        riskScoreThreshold: 10,
      }),
      allowed: true,
      rule: "whitelist",
    },
    // --- blacklist ---
    {
      name: "blacklist exact match blocks",
      domain: "bad.com",
      verdict: verdict(),
      policy: policy({ blacklist: ["bad.com"] }),
      allowed: false,
      rule: "blacklist",
    },
    {
      name: "blacklist exact entry also blocks subdomains",
      domain: "cdn.bad.com",
      verdict: verdict(),
      policy: policy({ blacklist: ["bad.com"] }),
      allowed: false,
      rule: "blacklist",
    },
    {
      name: "blacklist glob blocks matching subdomains",
      domain: "evil.bad.com",
      verdict: verdict(),
      policy: policy({ blacklist: ["*.bad.com"] }),
      allowed: false,
      rule: "blacklist",
    },
    {
      name: "blacklist wins over blocked TLD (rule ordering)",
      domain: "bad.zip",
      verdict: verdict(),
      policy: policy({ blacklist: ["bad.zip"], blockedTlds: ["zip"] }),
      allowed: false,
      rule: "blacklist",
    },
    // --- blocked-tld ---
    {
      name: "blocked TLD blocks matching domains",
      domain: "archive.zip",
      verdict: verdict(),
      policy: policy({ blockedTlds: ["zip"] }),
      allowed: false,
      rule: "blocked-tld",
    },
    {
      name: "blocked TLD respects label boundaries (foozip.com passes)",
      domain: "foozip.com",
      verdict: verdict(),
      policy: policy({ blockedTlds: ["zip"] }),
      allowed: true,
      rule: "default-allow",
    },
    {
      name: "blocked TLD supports multi-label suffixes",
      domain: "shop.co.uk",
      verdict: verdict(),
      policy: policy({ blockedTlds: ["co.uk"] }),
      allowed: false,
      rule: "blocked-tld",
    },
    {
      name: "blocked TLD tolerates a leading dot in the entry",
      domain: "archive.zip",
      verdict: verdict(),
      policy: policy({ blockedTlds: [".zip"] }),
      allowed: false,
      rule: "blocked-tld",
    },
    {
      name: "blocked TLD wins over blocked country (rule ordering)",
      domain: "archive.zip",
      verdict: verdict({ countryCode: "RU" }),
      policy: policy({ blockedTlds: ["zip"], blockedCountries: ["RU"] }),
      allowed: false,
      rule: "blocked-tld",
    },
    // --- blocked-country ---
    {
      name: "blocked country blocks",
      domain: "example.com",
      verdict: verdict({ countryCode: "RU" }),
      policy: policy({ blockedCountries: ["RU"] }),
      allowed: false,
      rule: "blocked-country",
    },
    {
      name: "blocked country comparison is case-insensitive",
      domain: "example.com",
      verdict: verdict({ countryCode: "RU" }),
      policy: policy({ blockedCountries: ["ru"] }),
      allowed: false,
      rule: "blocked-country",
    },
    {
      name: "null country code never matches blocked countries",
      domain: "example.com",
      verdict: verdict({ countryCode: null }),
      policy: policy({ blockedCountries: ["RU"] }),
      allowed: true,
      rule: "default-allow",
    },
    {
      name: "blocked country wins over domain age (rule ordering)",
      domain: "example.com",
      verdict: verdict({ countryCode: "RU", domainAgeDays: 1 }),
      policy: policy({ blockedCountries: ["RU"], maxDomainAgeDays: 30 }),
      allowed: false,
      rule: "blocked-country",
    },
    // --- domain-age ---
    {
      name: "domain younger than the threshold is blocked",
      domain: "example.com",
      verdict: verdict({ domainAgeDays: 5 }),
      policy: policy({ maxDomainAgeDays: 30 }),
      allowed: false,
      rule: "domain-age",
    },
    {
      name: "domain exactly at the threshold is allowed",
      domain: "example.com",
      verdict: verdict({ domainAgeDays: 30 }),
      policy: policy({ maxDomainAgeDays: 30 }),
      allowed: true,
      rule: "default-allow",
    },
    {
      name: "null maxDomainAgeDays disables the age rule",
      domain: "example.com",
      verdict: verdict({ domainAgeDays: 1 }),
      policy: policy({ maxDomainAgeDays: null }),
      allowed: true,
      rule: "default-allow",
    },
    {
      name: "unknown domain age never triggers the age rule",
      domain: "example.com",
      verdict: verdict({ domainAgeDays: null }),
      policy: policy({ maxDomainAgeDays: 30 }),
      allowed: true,
      rule: "default-allow",
    },
    {
      name: "domain age wins over denied category (rule ordering)",
      domain: "example.com",
      verdict: verdict({ domainAgeDays: 1, categories: ["Gambling"] }),
      policy: policy({
        maxDomainAgeDays: 30,
        deniedCategories: ["Gambling"],
      }),
      allowed: false,
      rule: "domain-age",
    },
    // --- denied-category ---
    {
      name: "denied category blocks",
      domain: "example.com",
      verdict: verdict({ categories: ["Gambling", "Games"] }),
      policy: policy({ deniedCategories: ["Gambling"] }),
      allowed: false,
      rule: "denied-category",
    },
    {
      name: "denied category comparison is case-insensitive",
      domain: "example.com",
      verdict: verdict({ categories: ["gambling"] }),
      policy: policy({ deniedCategories: ["GAMBLING"] }),
      allowed: false,
      rule: "denied-category",
    },
    {
      name: "non-denied categories pass",
      domain: "example.com",
      verdict: verdict({ categories: ["News"] }),
      policy: policy({ deniedCategories: ["Gambling"] }),
      allowed: true,
      rule: "default-allow",
    },
    {
      name: "denied category wins over risk score (rule ordering)",
      domain: "example.com",
      verdict: verdict({ categories: ["Gambling"], riskScore: 100 }),
      policy: policy({ deniedCategories: ["Gambling"] }),
      allowed: false,
      rule: "denied-category",
    },
    // --- risk-score ---
    {
      name: "score at the threshold is blocked",
      domain: "example.com",
      verdict: verdict({ riskScore: 75 }),
      policy: policy({ riskScoreThreshold: 75 }),
      allowed: false,
      rule: "risk-score",
    },
    {
      name: "score above the threshold is blocked",
      domain: "example.com",
      verdict: verdict({ riskScore: 100 }),
      policy: policy({ riskScoreThreshold: 75 }),
      allowed: false,
      rule: "risk-score",
    },
    {
      name: "score below the threshold is allowed",
      domain: "example.com",
      verdict: verdict({ riskScore: 74 }),
      policy: policy({ riskScoreThreshold: 75 }),
      allowed: true,
      rule: "default-allow",
    },
    {
      name: "null score never triggers the risk-score rule",
      domain: "example.com",
      verdict: verdict({ riskScore: null }),
      policy: policy({ riskScoreThreshold: 0 }),
      allowed: true,
      rule: "default-allow",
    },
    // --- provider-failure ---
    {
      name: "provider failure with fail-closed blocks",
      domain: "example.com",
      verdict: null,
      policy: policy({ failurePolicy: "closed" }),
      allowed: false,
      rule: "provider-failure",
    },
    {
      name: "provider failure with fail-open allows",
      domain: "example.com",
      verdict: null,
      policy: policy({ failurePolicy: "open" }),
      allowed: true,
      rule: "provider-failure",
    },
    {
      name: "provider failure in normal mode also honors fail-open",
      domain: "example.com",
      verdict: null,
      policy: policy({ mode: "normal", failurePolicy: "open" }),
      allowed: true,
      rule: "provider-failure",
    },
    {
      name: "local rules still decide when the provider failed",
      domain: "bad.com",
      verdict: null,
      policy: policy({ blacklist: ["bad.com"], failurePolicy: "open" }),
      allowed: false,
      rule: "blacklist",
    },
    {
      name: "mode off with no verdict allows by default (not provider-failure)",
      domain: "example.com",
      verdict: null,
      policy: policy({ mode: "off", failurePolicy: "closed" }),
      allowed: true,
      rule: "default-allow",
    },
    // --- default-allow ---
    {
      name: "clean verdict passes every rule",
      domain: "example.com",
      verdict: verdict(),
      policy: policy({
        riskScoreThreshold: 50,
        deniedCategories: ["Gambling"],
        maxDomainAgeDays: 30,
        blockedTlds: ["zip"],
        blockedCountries: ["KP"],
      }),
      allowed: true,
      rule: "default-allow",
    },
  ];

  test.each(cases)("$name", ({ domain, verdict, policy, allowed, rule }) => {
    const decision = evaluatePolicy(domain, verdict, policy);
    expect(decision.allowed).toBe(allowed);
    expect(decision.rule).toBe(rule);
    expect(decision.mode).toBe(policy.mode);
    expect(decision.verdict).toBe(verdict);
    // Billing invariant: providerConsulted iff a verdict (fresh or cached)
    // was passed in — regardless of which rule decided.
    expect(decision.providerConsulted).toBe(verdict !== null);
  });
});

describe("localOnlyDecision", () => {
  it("resolves whitelisted domains without a provider", () => {
    const decision = localOnlyDecision(
      "example.com",
      policy({ whitelist: ["example.com"] }),
    );
    expect(decision).toEqual({
      allowed: true,
      rule: "whitelist",
      providerConsulted: false,
      verdict: null,
      mode: "enhanced",
    });
  });

  it("resolves blacklisted domains without a provider", () => {
    const decision = localOnlyDecision(
      "sub.bad.com",
      policy({ blacklist: ["bad.com"] }),
    );
    expect(decision).toMatchObject({
      allowed: false,
      rule: "blacklist",
      providerConsulted: false,
      verdict: null,
    });
  });

  it("resolves blocked TLDs without a provider", () => {
    const decision = localOnlyDecision(
      "archive.zip",
      policy({ blockedTlds: ["zip"] }),
    );
    expect(decision).toMatchObject({
      allowed: false,
      rule: "blocked-tld",
      providerConsulted: false,
    });
  });

  it("prefers the whitelist over blacklist and blocked TLDs", () => {
    const decision = localOnlyDecision(
      "good.zip",
      policy({
        whitelist: ["good.zip"],
        blacklist: ["*.zip", "good.zip"],
        blockedTlds: ["zip"],
      }),
    );
    expect(decision).toMatchObject({ allowed: true, rule: "whitelist" });
  });

  it("returns null when only provider-backed rules could decide", () => {
    expect(
      localOnlyDecision(
        "example.com",
        policy({
          riskScoreThreshold: 10,
          deniedCategories: ["Gambling"],
          blockedCountries: ["KP"],
          maxDomainAgeDays: 30,
        }),
      ),
    ).toBeNull();
  });

  it("normalizes URL-ish input before matching", () => {
    const decision = localOnlyDecision(
      "HTTPS://Sub.Example.COM/some/path?q=1",
      policy({ blacklist: ["example.com"] }),
    );
    expect(decision).toMatchObject({ allowed: false, rule: "blacklist" });
  });
});

describe("normalizeDomain", () => {
  test.each([
    ["Example.COM", "example.com"],
    ["  example.com  ", "example.com"],
    ["example.com.", "example.com"],
    ["https://sub.example.com/path?q=1", "sub.example.com"],
    ["example.com:8080", "example.com"],
    ["example.com/path", "example.com"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });
});
