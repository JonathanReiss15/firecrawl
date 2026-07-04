// Shared type contract for the threat protection feature.
// NOTE: concurrent in-flight branches create this exact file — do not modify without coordinating.

export type ThreatProtectionMode = "off" | "normal" | "enhanced";

export interface ThreatProtectionPolicy {
  mode: ThreatProtectionMode;
  /** Normalized 0-100; verdicts at or above this score are blocked. */
  riskScoreThreshold: number;
  /** Content category names (enhanced mode only). */
  deniedCategories: string[];
  /** Block domains registered more recently than this many days ago; null disables. Enhanced mode only. */
  maxDomainAgeDays: number | null;
  /** Exact domains or globs like "*.example.com". Blocks without a provider call. */
  blacklist: string[];
  /** Exact domains or globs. Allows without a provider call; wins over everything. */
  whitelist: string[];
  /** Lowercase TLDs without leading dot, e.g. "zip". Blocks without a provider call. */
  blockedTlds: string[];
  /** ISO 3166-1 alpha-2 country codes (enhanced mode only). */
  blockedCountries: string[];
  /** Behavior when the provider is unavailable: "closed" blocks, "open" allows. */
  failurePolicy: "open" | "closed";
}

export const THREAT_PROTECTION_POLICY_DEFAULTS: Omit<
  ThreatProtectionPolicy,
  "mode"
> = {
  riskScoreThreshold: 75,
  deniedCategories: [],
  maxDomainAgeDays: null,
  blacklist: [],
  whitelist: [],
  blockedTlds: [],
  blockedCountries: [],
  failurePolicy: "closed",
};

export type ThreatProvider = "google-web-risk" | "alphamountain";

export interface RawVerdict {
  provider: ThreatProvider;
  /** Normalized 0-100, higher = riskier; null if the provider gave no score. */
  riskScore: number | null;
  /** Content category names (enhanced mode); Web Risk threat types mapped to category strings (normal mode). */
  categories: string[];
  /** Days since domain registration (enhanced mode only). */
  domainAgeDays: number | null;
  /** ISO 3166-1 alpha-2 (enhanced mode only). */
  countryCode: string | null;
  fromCache: boolean;
  /** Raw provider payload, for security logging. */
  raw: unknown;
}

export type ThreatDecisionRule =
  | "whitelist"
  | "blacklist"
  | "blocked-tld"
  | "blocked-country"
  | "domain-age"
  | "denied-category"
  | "risk-score"
  | "provider-failure"
  | "default-allow";

export interface ThreatDecision {
  allowed: boolean;
  rule: ThreatDecisionRule;
  /** True if a provider verdict (fresh OR cached) was consulted — this drives billing (+2 normal / +3 enhanced). */
  providerConsulted: boolean;
  verdict: RawVerdict | null;
  mode: ThreatProtectionMode;
}
