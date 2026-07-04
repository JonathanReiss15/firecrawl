import { z } from "zod";
import {
  THREAT_PROTECTION_POLICY_DEFAULTS,
  type ThreatProtectionPolicy,
} from "./types";

// =========================================
// alphaMountain content categories
// =========================================

/**
 * Full list of alphaMountain content category names, as published at
 * https://www.alphamountain.ai/categories/ (retrieved 2026-07-04).
 *
 * Keep this list in sync with the provider. `deniedCategories` in the
 * threat protection policy is validated against it.
 */
export const ALPHAMOUNTAIN_CATEGORIES = [
  "Abortion",
  "Adult/Mature",
  "Ads/Analytics",
  "AI/ML Applications",
  "Alcohol",
  "Alternative Currency",
  "Alternative Ideology",
  "Anonymizers",
  "Arts/Culture",
  "Auctions/Classifieds",
  "Audio",
  "Brokerage/Trading",
  "Business/Economy",
  "Chat/IM/SMS",
  "Child Pornography/Abuse",
  "Content Servers",
  "Dating/Personals",
  "Digital Postcards",
  "DNS over HTTP",
  "Drugs/Controlled Substances",
  "Dynamic DNS",
  "Education",
  "Email",
  "Entertainment",
  "Extreme/Gruesome",
  "File Sharing/Storage",
  "Finance",
  "For Kids",
  "Forums",
  "Gambling",
  "Games",
  "Government/Legal",
  "Hacking",
  "Hate/Discrimination",
  "Health",
  "Hobbies/Recreation",
  "Hosting",
  "Humor/Comics",
  "Information Technology",
  "Information/Computer Security",
  "Infrastructure/IOT",
  "Job Search",
  "Lingerie/Swimsuit",
  "Local/Non-Routable",
  "Login/Challenge",
  "Malicious",
  "Marijuana",
  "Marketing/Merchandising",
  "Media Sharing",
  "Military",
  "Mixed Content/Potentially Adult",
  "Network Access/Captive Portal",
  "News",
  "Newly Registered",
  "Non-Profit/Advocacy",
  "Nudity",
  "Parked Site",
  "Peer-to-Peer (P2P)",
  "Personal Sites/Blogs",
  "Phishing",
  "Piracy/Plagiarism",
  "Politics/Opinion",
  "Pornography",
  "Potentially Unwanted Programs",
  "Productivity Applications",
  "Promotional Compensation",
  "Real Estate",
  "Reference",
  "Religion",
  "Remote Access",
  "Restaurants/Food",
  "Scam/Illegal/Unethical",
  "Search Engines/Portals",
  "Sex Education",
  "Shopping",
  "Social Networking",
  "Society/Lifestyle",
  "Software Downloads",
  "Spam",
  "Sports",
  "Suspicious",
  "Telephony",
  "Tobacco",
  "Translation",
  "Travel",
  "Unrated",
  "URL Redirect",
  "Vehicles",
  "Video/Multimedia",
  "Violence",
  "Virtual Meetings",
  "Weapons",
] as const;

const ALPHAMOUNTAIN_CATEGORY_SET = new Set<string>(ALPHAMOUNTAIN_CATEGORIES);

/**
 * Sensible security-focused default for `deniedCategories` in enhanced mode:
 * clearly malicious categories plus the categories enterprise compliance
 * teams most commonly deny.
 */
export const DEFAULT_DENIED_CATEGORIES: string[] = [
  // Clearly malicious / abuse
  "Malicious",
  "Phishing",
  "Spam",
  "Suspicious",
  "Scam/Illegal/Unethical",
  "Hacking",
  "Potentially Unwanted Programs",
  "Child Pornography/Abuse",
  // Common enterprise compliance denials
  "Weapons",
  "Violence",
  "Hate/Discrimination",
  "Extreme/Gruesome",
  "Drugs/Controlled Substances",
  "Gambling",
  "Pornography",
  "Nudity",
  "Adult/Mature",
  "Piracy/Plagiarism",
];

// =========================================
// Field schemas
// =========================================

// One DNS label: alphanumeric, optionally with inner hyphens, max 63 chars.
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Plain domain ("example.com", "sub.example.co.uk") or a single leading
// wildcard label ("*.example.com"). No protocol, path, port, or inner "*".
const DOMAIN_GLOB_REGEX = new RegExp(
  `^(\\*\\.)?(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`,
);

const domainGlobSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(value => value.length <= 253 && DOMAIN_GLOB_REGEX.test(value), {
    error: iss =>
      `Invalid domain entry ${JSON.stringify(iss.input)}: must be a plain domain like "example.com" or a wildcard glob like "*.example.com" (no protocol, path, or port)`,
  });

const tldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(value => /^[a-z0-9]{1,63}$/.test(value), {
    error: iss =>
      `Invalid TLD ${JSON.stringify(iss.input)}: must be a lowercase alphanumeric TLD without the leading dot, e.g. "zip"`,
  });

const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(value => /^[A-Z]{2}$/.test(value), {
    error: iss =>
      `Invalid country code ${JSON.stringify(iss.input)}: must be an ISO 3166-1 alpha-2 code, e.g. "US"`,
  });

const deniedCategorySchema = z
  .string()
  .refine(value => ALPHAMOUNTAIN_CATEGORY_SET.has(value), {
    error: iss =>
      `Unknown content category ${JSON.stringify(iss.input)}: must be one of the alphaMountain category names`,
  });

// =========================================
// Policy + org config schemas
// =========================================

/**
 * Field-for-field zod schema for {@link ThreatProtectionPolicy}. Every field
 * except `mode` defaults to {@link THREAT_PROTECTION_POLICY_DEFAULTS}.
 */
export const threatProtectionPolicySchema = z.strictObject({
  mode: z.enum(["off", "normal", "enhanced"]),
  riskScoreThreshold: z
    .number()
    .int()
    .min(0)
    .max(100)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.riskScoreThreshold),
  deniedCategories: z
    .array(deniedCategorySchema)
    .max(ALPHAMOUNTAIN_CATEGORIES.length)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.deniedCategories),
  maxDomainAgeDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .nullable()
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.maxDomainAgeDays),
  blacklist: z
    .array(domainGlobSchema)
    .max(1000)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.blacklist),
  whitelist: z
    .array(domainGlobSchema)
    .max(1000)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.whitelist),
  blockedTlds: z
    .array(tldSchema)
    .max(1000)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.blockedTlds),
  blockedCountries: z
    .array(countryCodeSchema)
    .max(250)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.blockedCountries),
  failurePolicy: z
    .enum(["open", "closed"])
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.failurePolicy),
});

// Compile-time assertion that the schema output matches the shared contract
// in ./types.ts — fails to typecheck if the two drift apart.
const _policyContractCheck = (
  x: z.infer<typeof threatProtectionPolicySchema>,
): ThreatProtectionPolicy => x;
void _policyContractCheck;

/**
 * Per-request `threatProtection` option: a field-level override of the org
 * config. Mirrors {@link threatProtectionPolicySchema} but every field is
 * optional and NO defaults are injected — only fields the caller explicitly
 * provides replace the org policy's values (see `resolveEffectivePolicy`).
 */
export const threatProtectionOverrideSchema = z.strictObject({
  mode: z.enum(["off", "normal", "enhanced"]).optional(),
  riskScoreThreshold: z.number().int().min(0).max(100).optional(),
  deniedCategories: z
    .array(deniedCategorySchema)
    .max(ALPHAMOUNTAIN_CATEGORIES.length)
    .optional(),
  maxDomainAgeDays: z.number().int().min(1).max(3650).nullable().optional(),
  blacklist: z.array(domainGlobSchema).max(1000).optional(),
  whitelist: z.array(domainGlobSchema).max(1000).optional(),
  blockedTlds: z.array(tldSchema).max(1000).optional(),
  blockedCountries: z.array(countryCodeSchema).max(250).optional(),
  failurePolicy: z.enum(["open", "closed"]).optional(),
});

type ThreatProtectionOverride = z.infer<typeof threatProtectionOverrideSchema>;

// Compile-time assertion that the override shape stays assignable to
// Partial<ThreatProtectionPolicy> (what `resolveEffectivePolicy` consumes).
const _overrideContractCheck = (
  x: ThreatProtectionOverride,
): Partial<ThreatProtectionPolicy> => x;
void _overrideContractCheck;

const siemConfigSchema = z.strictObject({
  url: z
    .url({
      protocol: /^https?$/,
      error: "SIEM url must be a valid http(s) URL",
    })
    .max(2048),
  secret: z.string().min(1).max(4096).nullable().prefault(null),
  events: z.enum(["blocked", "all"]).prefault("blocked"),
});

/**
 * Full org-level configuration document, as accepted by
 * `PUT /v2/team/threat-protection`.
 */
export const threatProtectionConfigSchema = threatProtectionPolicySchema.extend(
  {
    allowRequestOverrides: z.boolean().prefault(true),
    siem: siemConfigSchema.nullable().prefault(null),
  },
);

export type ThreatProtectionConfigInput = z.infer<
  typeof threatProtectionConfigSchema
>;
