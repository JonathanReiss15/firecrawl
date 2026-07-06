import { fetch } from "undici";
import { z } from "zod";

import { config } from "../config";
import type { FormatObject } from "../controllers/v2/types";
import { logger as rootLogger } from "./logger";

type AcceptedDataSourceTerms = Record<
  string,
  string | string[] | Record<string, unknown> | null | undefined
>;

type RouteInput = {
  url: string;
  formats?: FormatObject[] | unknown[];
  actions?: unknown[];
  headers?: Record<string, unknown>;
  waitFor?: number;
  mobile?: boolean;
  location?: unknown;
  proxy?: unknown;
  blockAds?: boolean;
  zeroDataRetention?: boolean;
  lockdown?: boolean;
  flags?: {
    professionalProfileCompanyDataBeta?: boolean;
    acceptedDataSourceTerms?: AcceptedDataSourceTerms | null;
  } | null;
};

export type DataLayerScrapeMetadata = {
  handled: true;
  integrationId?: string;
};

const SUPPORTED_FORMATS = new Set(["markdown", "json", "deterministicJson"]);
const DATA_LAYER_SUCCESS_CREDITS = 15;
export const PROFESSIONAL_PROFILE_COMPANY_DATA_TERMS_SOURCE_ID =
  "professional_profile_company_data";
export const PROFESSIONAL_PROFILE_COMPANY_DATA_BETA_FLAG =
  "professionalProfileCompanyDataBeta";
export const THIRD_PARTY_DATA_TERMS_VERSION = "2026-07-03";
export const THIRD_PARTY_DATA_TERMS_REQUIRED_CODE =
  "THIRD_PARTY_DATA_TERMS_REQUIRED";
export const THIRD_PARTY_DATA_TERMS_REQUIRED_MESSAGE =
  "An organization admin must accept the Professional Profile & Company Data terms before this URL can be processed.";

const DATA_LAYER_CAPABILITIES_PATH = "/v1/data-layer/capabilities";
const DATA_LAYER_CAPABILITIES_TIMEOUT_MS = 2_000;
const DATA_LAYER_CAPABILITIES_FALLBACK_TTL_MS = 30_000;

const dataLayerCapabilitiesSchema = z
  .object({
    version: z.number().optional(),
    ttlSeconds: z.number().positive().optional(),
    domains: z.string().array().optional(),
    baseDomains: z.string().array().optional(),
  })
  .passthrough();

type DataLayerCapabilities = {
  domains: Set<string>;
  baseDomains: Set<string>;
  ttlMs: number;
};

let cachedCapabilities:
  | {
      expiresAt: number;
      value: DataLayerCapabilities | null;
    }
  | undefined;
let capabilitiesRequest: Promise<DataLayerCapabilities | null> | undefined;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeCapabilities(
  raw: z.infer<typeof dataLayerCapabilitiesSchema>,
): DataLayerCapabilities {
  const ttlMs =
    typeof raw.ttlSeconds === "number" && Number.isFinite(raw.ttlSeconds)
      ? raw.ttlSeconds * 1000
      : DATA_LAYER_CAPABILITIES_FALLBACK_TTL_MS;

  return {
    domains: new Set((raw.domains ?? []).map(normalizeHost)),
    baseDomains: new Set((raw.baseDomains ?? []).map(normalizeHost)),
    ttlMs: Math.max(1_000, ttlMs),
  };
}

function getFireEngineDataLayerUrl(): string | null {
  if (!config.FIRE_ENGINE_BETA_URL) {
    return null;
  }

  return `${config.FIRE_ENGINE_BETA_URL.replace(/\/+$/, "")}${DATA_LAYER_CAPABILITIES_PATH}`;
}

async function fetchDataLayerCapabilities(): Promise<DataLayerCapabilities | null> {
  const url = getFireEngineDataLayerUrl();
  if (!url) {
    return null;
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(DATA_LAYER_CAPABILITIES_TIMEOUT_MS),
    });

    if (!response.ok) {
      rootLogger.warn("Data layer capabilities request failed", {
        statusCode: response.status,
      });
      return null;
    }

    const parsed = dataLayerCapabilitiesSchema.parse(await response.json());
    return normalizeCapabilities(parsed);
  } catch (error) {
    rootLogger.warn("Data layer capabilities request errored", { error });
    return null;
  }
}

async function getDataLayerCapabilities(): Promise<DataLayerCapabilities | null> {
  if (cachedCapabilities && cachedCapabilities.expiresAt > Date.now()) {
    return cachedCapabilities.value;
  }

  if (!capabilitiesRequest) {
    capabilitiesRequest = fetchDataLayerCapabilities().finally(() => {
      capabilitiesRequest = undefined;
    });
  }

  const capabilities = await capabilitiesRequest;
  cachedCapabilities = {
    value: capabilities,
    expiresAt:
      Date.now() +
      (capabilities?.ttlMs ?? DATA_LAYER_CAPABILITIES_FALLBACK_TTL_MS),
  };

  return capabilities;
}

function dataLayerCapabilitiesMatchUrl(
  capabilities: DataLayerCapabilities,
  inputUrl: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return false;
  }

  const host = normalizeHost(parsed.hostname);
  if (capabilities.domains.has(host)) {
    return true;
  }

  for (const baseDomain of capabilities.baseDomains) {
    if (host === baseDomain || host.endsWith(`.${baseDomain}`)) {
      return true;
    }
  }

  return false;
}

export async function isDataLayerSupportedUrl(
  inputUrl: string,
): Promise<boolean> {
  const capabilities = await getDataLayerCapabilities();
  return (
    capabilities !== null &&
    dataLayerCapabilitiesMatchUrl(capabilities, inputUrl)
  );
}

export function getDataLayerRequestLogContext(inputUrl: string):
  | {
      url: string;
      host: string;
      pathPrefix: string | null;
    }
  | undefined {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return undefined;
  }

  return {
    url: parsed.href,
    host: parsed.hostname.toLowerCase(),
    pathPrefix:
      parsed.pathname
        .split("/")
        .map(part => part.trim())
        .filter(part => part.length > 0)[0] ?? null,
  };
}

export function getDataLayerResponseLogContext(meta: unknown): {
  cacheState?: string;
  cachedAt?: string;
  cacheAgeMs?: number;
  providerRequestId?: string;
} {
  if (typeof meta !== "object" || meta === null) {
    return {};
  }

  const record = meta as Record<string, unknown>;
  const requestId = record.request_id ?? record.requestId;

  return {
    ...(typeof record.cacheState === "string"
      ? { cacheState: record.cacheState }
      : {}),
    ...(typeof record.cachedAt === "string"
      ? { cachedAt: record.cachedAt }
      : {}),
    ...(typeof record.cacheAgeMs === "number"
      ? { cacheAgeMs: record.cacheAgeMs }
      : {}),
    ...(typeof requestId === "string" ? { providerRequestId: requestId } : {}),
  };
}

export function isSuccessfulDataLayerStatusCode(statusCode: number): boolean {
  return (statusCode >= 200 && statusCode < 300) || statusCode === 304;
}

export function isSupportedDataLayerFormatRequest(
  formats?: FormatObject[] | unknown[],
): boolean {
  if (formats === undefined) {
    return true;
  }

  if (!Array.isArray(formats) || formats.length === 0) {
    return false;
  }

  return formats.every(format => {
    const type =
      typeof format === "string"
        ? format
        : typeof format === "object" && format !== null && "type" in format
          ? (format as { type?: unknown }).type
          : undefined;

    return typeof type === "string" && SUPPORTED_FORMATS.has(type);
  });
}

function hasAcceptedDataSourceTerms(
  flags: RouteInput["flags"],
  sourceId: string,
  version: string,
): boolean {
  const accepted = flags?.acceptedDataSourceTerms?.[sourceId];

  if (Array.isArray(accepted)) {
    return accepted.includes(version);
  }

  if (typeof accepted === "string") {
    return accepted === version;
  }

  if (typeof accepted === "object" && accepted !== null) {
    return accepted[version] === true || typeof accepted[version] === "string";
  }

  return false;
}

function hasAcceptedThirdPartyDataTerms(flags: RouteInput["flags"]): boolean {
  if (config.USE_DB_AUTHENTICATION !== true) {
    return true;
  }

  return hasAcceptedDataSourceTerms(
    flags,
    PROFESSIONAL_PROFILE_COMPANY_DATA_TERMS_SOURCE_ID,
    THIRD_PARTY_DATA_TERMS_VERSION,
  );
}

function isDataLayerEligibleRequest(input: RouteInput): boolean {
  if (input.flags?.[PROFESSIONAL_PROFILE_COMPANY_DATA_BETA_FLAG] !== true) {
    return false;
  }

  if (!config.FIRE_ENGINE_BETA_URL) {
    return false;
  }

  if (!input.url) {
    return false;
  }

  if (input.zeroDataRetention || input.lockdown) {
    return false;
  }

  if (Array.isArray(input.actions) && input.actions.length > 0) {
    return false;
  }

  if (input.headers && Object.keys(input.headers).length > 0) {
    return false;
  }

  if (input.waitFor !== undefined && input.waitFor !== 0) {
    return false;
  }

  if (input.mobile || input.location || input.blockAds === false) {
    return false;
  }

  if (input.proxy === "stealth" || input.proxy === "enhanced") {
    return false;
  }

  if (!isSupportedDataLayerFormatRequest(input.formats)) {
    return false;
  }

  return true;
}

export async function getDataLayerAccessForRequest(input: RouteInput): Promise<
  | {
      allowed: true;
      termsRequired: false;
    }
  | {
      allowed: false;
      termsRequired: boolean;
    }
> {
  if (!isDataLayerEligibleRequest(input)) {
    return { allowed: false, termsRequired: false };
  }

  const supported = await isDataLayerSupportedUrl(input.url);
  if (!supported) {
    return { allowed: false, termsRequired: false };
  }

  if (!hasAcceptedThirdPartyDataTerms(input.flags)) {
    return { allowed: false, termsRequired: true };
  }

  return { allowed: true, termsRequired: false };
}

export async function canUseDataLayerForRequest(
  input: RouteInput,
): Promise<boolean> {
  return (await getDataLayerAccessForRequest(input)).allowed;
}

export function getThirdPartyDataTermsSettingsUrl(): string {
  return `${config.FIRECRAWL_DASHBOARD_URL.replace(/\/+$/, "")}/app/settings?tab=data-sources`;
}

export function getThirdPartyDataTermsRequiredResponse() {
  return {
    success: false,
    code: THIRD_PARTY_DATA_TERMS_REQUIRED_CODE,
    error: THIRD_PARTY_DATA_TERMS_REQUIRED_MESSAGE,
    requiresAction: {
      type: "accept_terms",
      terms: PROFESSIONAL_PROFILE_COMPANY_DATA_TERMS_SOURCE_ID,
      version: THIRD_PARTY_DATA_TERMS_VERSION,
      url: getThirdPartyDataTermsSettingsUrl(),
    },
  };
}

export function getDataLayerSuccessCredits(input: {
  dataLayer?: DataLayerScrapeMetadata;
  statusCode?: number | null;
}): number | null {
  if (input.dataLayer?.handled !== true) {
    return null;
  }

  const statusCode = input.statusCode;
  if (
    statusCode === undefined ||
    statusCode === null ||
    !isSuccessfulDataLayerStatusCode(statusCode)
  ) {
    return null;
  }

  return DATA_LAYER_SUCCESS_CREDITS;
}

export function setDataLayerCapabilitiesForTest(input: {
  domains?: string[];
  baseDomains?: string[];
  ttlSeconds?: number;
}) {
  cachedCapabilities = {
    value: normalizeCapabilities(input),
    expiresAt: Date.now() + (input.ttlSeconds ?? 300) * 1000,
  };
}

export function clearDataLayerCapabilitiesForTest() {
  cachedCapabilities = undefined;
  capabilitiesRequest = undefined;
}
