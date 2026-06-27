import { fetch } from "undici";
import { sql } from "drizzle-orm";
import { validate as isUuid } from "uuid";
import { z } from "zod";

import { config } from "../config";
import type { FormatObject } from "../controllers/v2/types";
import { dbRr } from "../db/connection";
import { logger as rootLogger } from "./logger";

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
  flags?: { enrichBeta?: boolean } | null;
  teamId?: string | null;
};

export type DataLayerScrapeMetadata = {
  handled: true;
  integrationId?: string;
};

const SUPPORTED_FORMATS = new Set(["markdown", "json", "deterministicJson"]);
const DATA_LAYER_SUCCESS_CREDITS = 15;
export const THIRD_PARTY_DATA_TERMS_SOURCE_ID = "third_party_data";
export const THIRD_PARTY_DATA_TERMS_VERSION = "2026-06-26";
export const THIRD_PARTY_DATA_TERMS_REQUIRED_CODE =
  "THIRD_PARTY_DATA_TERMS_REQUIRED";
export const THIRD_PARTY_DATA_TERMS_REQUIRED_MESSAGE =
  "A team admin must accept the Third-Party Data terms before this URL can be processed.";

const DATA_LAYER_CAPABILITIES_PATH = "/v1/data-layer/capabilities";
const DATA_LAYER_CAPABILITIES_TIMEOUT_MS = 2_000;
const DATA_LAYER_CAPABILITIES_FALLBACK_TTL_MS = 30_000;
const THIRD_PARTY_DATA_TERMS_CACHE_TTL_MS = 60_000;
const THIRD_PARTY_DATA_TERMS_ERROR_CACHE_TTL_MS = 10_000;

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
let cachedTermsAcceptance = new Map<
  string,
  {
    expiresAt: number;
    accepted: boolean;
  }
>();
let termsAcceptanceForTest: Map<string, boolean> | undefined;

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

function isCurrentThirdPartyDataTermsAccepted(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }

  const record = input as Record<string, unknown>;
  const entry = record[THIRD_PARTY_DATA_TERMS_SOURCE_ID];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }

  return (
    (entry as Record<string, unknown>).version ===
    THIRD_PARTY_DATA_TERMS_VERSION
  );
}

async function hasAcceptedThirdPartyDataTerms(
  teamId?: string | null,
): Promise<boolean> {
  if (config.USE_DB_AUTHENTICATION !== true) {
    return true;
  }

  if (!teamId || !isUuid(teamId)) {
    return false;
  }

  const testValue = termsAcceptanceForTest?.get(teamId);
  if (testValue !== undefined) {
    return testValue;
  }

  const cached = cachedTermsAcceptance.get(teamId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accepted;
  }

  try {
    const result = await dbRr.execute(
      sql`
        select o.data_source_terms
        from teams t
        join organizations o on o.id = t.org_id
        where t.id = ${teamId}
        limit 1
      `,
    );
    const organization = result.rows?.[0] as
      | { data_source_terms?: unknown }
      | undefined;
    const accepted = isCurrentThirdPartyDataTermsAccepted(
      organization?.data_source_terms,
    );

    cachedTermsAcceptance.set(teamId, {
      accepted,
      expiresAt: Date.now() + THIRD_PARTY_DATA_TERMS_CACHE_TTL_MS,
    });

    return accepted;
  } catch (error) {
    rootLogger.warn("Third-Party Data terms lookup failed", {
      error,
      teamId,
    });
    cachedTermsAcceptance.set(teamId, {
      accepted: false,
      expiresAt: Date.now() + THIRD_PARTY_DATA_TERMS_ERROR_CACHE_TTL_MS,
    });
    return false;
  }
}

function isDataLayerEligibleRequest(input: RouteInput): boolean {
  if (input.flags?.enrichBeta !== true) {
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

  if (!(await hasAcceptedThirdPartyDataTerms(input.teamId))) {
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
      terms: THIRD_PARTY_DATA_TERMS_SOURCE_ID,
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

export function setThirdPartyDataTermsAcceptedForTest(
  teamId: string,
  accepted: boolean,
) {
  termsAcceptanceForTest ??= new Map();
  termsAcceptanceForTest.set(teamId, accepted);
}

export function clearDataLayerCapabilitiesForTest() {
  cachedCapabilities = undefined;
  capabilitiesRequest = undefined;
  cachedTermsAcceptance.clear();
  termsAcceptanceForTest = undefined;
}
