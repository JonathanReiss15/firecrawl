import { TeamFlags } from "../controllers/v2/types";
import {
  getScrapeZDR,
  getIgnoreRobots,
  getCustomRobotsAgent,
  getThreatProtection,
} from "./zdr-helpers";

type LocationOptions = { country?: string };

interface APIRequest {
  zeroDataRetention?: boolean;
  location?: LocationOptions;
  scrapeOptions?: {
    location?: LocationOptions;
  };
  crawlerOptions?: {
    ignoreRobotsTxt?: boolean;
    robotsUserAgent?: string;
  };
  // Per-request threat protection policy override. The request schema ships
  // with the enforcement PR; presence of any value gates on the team flag.
  threatProtection?: unknown;
}

interface PermissionOptions {
  /**
   * Org-level threat protection config (or the relevant slice of it), if
   * already loaded. When the org disables request overrides, any per-request
   * threatProtection option is rejected.
   */
  threatProtectionOrgConfig?: { allowRequestOverrides: boolean } | null;
}

const SUPPORT_EMAIL = "support@firecrawl.com";

export function checkPermissions(
  request: APIRequest,
  flags?: TeamFlags,
  options?: PermissionOptions,
): { error?: string } {
  // zdr perms — scrapeZDR must be 'allowed' or 'forced' for request-scoped ZDR
  const scrapeMode = getScrapeZDR(flags);
  if (
    request.zeroDataRetention &&
    scrapeMode !== "allowed" &&
    scrapeMode !== "forced"
  ) {
    return {
      error: `Zero Data Retention (ZDR) is not enabled for your team. Contact ${SUPPORT_EMAIL} to enable this feature.`,
    };
  }

  // robots perms — ignoreRobots must be 'allowed' or 'forced'
  const robotsMode = getIgnoreRobots(flags);
  if (
    request.crawlerOptions?.ignoreRobotsTxt &&
    robotsMode !== "allowed" &&
    robotsMode !== "forced"
  ) {
    return {
      error: `The ignoreRobotsTxt parameter is an enterprise feature. Contact ${SUPPORT_EMAIL} to explore whether it can be enabled for your team.`,
    };
  }
  // customRobotsAgent perms — separate flag for robotsUserAgent
  const customAgentMode = getCustomRobotsAgent(flags);
  if (
    request.crawlerOptions?.robotsUserAgent &&
    customAgentMode !== "allowed"
  ) {
    return {
      error: `The robotsUserAgent parameter is an enterprise feature. Contact ${SUPPORT_EMAIL} to explore whether it can be enabled for your team.`,
    };
  }

  // threat protection perms — the flag must be 'allowed' or 'forced' for any
  // per-request threatProtection option, and the org must not have locked
  // down request-level overrides.
  if (request.threatProtection !== undefined) {
    const threatMode = getThreatProtection(flags);
    if (threatMode !== "allowed" && threatMode !== "forced") {
      return {
        error: `Threat protection is an enterprise feature and is not enabled for your team. Contact ${SUPPORT_EMAIL} to explore whether it can be enabled for your team.`,
      };
    }
    if (options?.threatProtectionOrgConfig?.allowRequestOverrides === false) {
      return {
        error:
          "Per-request threat protection overrides are disabled by your organization's threat protection configuration.",
      };
    }
  }

  // ip whitelist perms
  const needsWhitelist =
    request.location?.country === "us-whitelist" ||
    request.scrapeOptions?.location?.country === "us-whitelist";

  if (needsWhitelist && !flags?.ipWhitelist) {
    return {
      error: `Static IP addresses are not enabled for your team. Contact ${SUPPORT_EMAIL} to get a dedicated set of IP addresses you can whitelist.`,
    };
  }

  return {};
}
