import type { ThreatDecision } from "./types";

// Error surfaced when threat protection blocks a domain. Kept module-local for
// now: the enforcement follow-up PR wires it into the scrape pipeline's
// TransportableError machinery (src/lib/error.ts) when it integrates
// checkDomain, so this PR doesn't have to touch the shared ErrorCodes union.

export class UnsafeDomainBlockedError extends Error {
  public readonly code = "unsafe_domain_blocked" as const;

  constructor(
    public readonly domain: string,
    public readonly decision: ThreatDecision,
  ) {
    super(
      `This domain (${domain}) is blocked by your organization's threat protection policy (rule: ${decision.rule}). ` +
        `If you believe this is a mistake, contact your organization administrator to adjust the policy (e.g. whitelist the domain).`,
    );
    this.name = "UnsafeDomainBlockedError";
  }
}
