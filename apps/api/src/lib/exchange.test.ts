import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../config";
import {
  canUseExchangeForRequest,
  clearExchangeProvidersForTest,
  confirmExchangeBilling,
  getExchangeAccessForRequest,
  getExchangeRequestLogContext,
  getExchangeResponseLogContext,
  getExchangeSuccessCredits,
  getThirdPartyDataTermsRequiredResponse,
  isExchangeSupportedUrl,
  isSuccessfulExchangeStatusCode,
  isSupportedExchangeFormatRequest,
  resolveExchangeProvider,
  setExchangeProvidersForTest,
} from "./exchange";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

const originalConfig = {
  EXCHANGE_URL: config.EXCHANGE_URL,
  USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
};

const ACME_TERMS = { key: "acme", version: "2026-01-01" };

const TEST_PROVIDERS = [
  {
    id: "acme",
    creditsCost: 12,
    terms: ACME_TERMS,
    routes: [
      {
        domains: ["profiles.example", "www.profiles.example"],
        pathPrefixes: ["/person/", "/company/"],
      },
    ],
  },
  {
    id: "openfacts",
    creditsCost: 0,
    routes: [{ domains: ["facts.example"] }],
  },
];

const ENABLED_EXCHANGE_FLAGS = {
  professionalProfileCompanyDataBeta: true,
  organizationDataSourceAccess: {
    acme: {
      status: "enabled",
      termsKey: "acme",
      termsVersion: "2026-01-01",
      termsAcceptedAt: "2026-01-01T00:00:00.000Z",
      enabledAt: "2026-01-01T00:00:00.000Z",
      disabledAt: null,
      disabledReason: null,
    },
  },
};

describe("Exchange routing", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    config.EXCHANGE_URL = "https://exchange.example";
    config.USE_DB_AUTHENTICATION = true;
    setExchangeProvidersForTest(TEST_PROVIDERS);
  });

  afterEach(() => {
    config.EXCHANGE_URL = originalConfig.EXCHANGE_URL;
    config.USE_DB_AUTHENTICATION = originalConfig.USE_DB_AUTHENTICATION;
    clearExchangeProvidersForTest();
  });

  it("resolves URLs to providers using catalog routes", async () => {
    await expect(
      resolveExchangeProvider(
        "https://profiles.example/person/example-person/details/?trk=foo",
      ),
    ).resolves.toMatchObject({ id: "acme", creditsCost: 12 });
    await expect(
      resolveExchangeProvider("https://www.profiles.example/company/example"),
    ).resolves.toMatchObject({ id: "acme" });
    await expect(
      resolveExchangeProvider("https://facts.example/any/path"),
    ).resolves.toMatchObject({ id: "openfacts" });
    await expect(
      resolveExchangeProvider("https://profiles.example/jobs/example"),
    ).resolves.toBeNull();
    await expect(
      resolveExchangeProvider("https://other.example/person/example"),
    ).resolves.toBeNull();
    await expect(resolveExchangeProvider("not a url")).resolves.toBeNull();

    await expect(
      isExchangeSupportedUrl("https://profiles.example/person/example-person"),
    ).resolves.toBe(true);
  });

  it("serves the stale catalog while refreshing in the background", async () => {
    setExchangeProvidersForTest(TEST_PROVIDERS, -1);
    let resolveFetch: (value: unknown) => void = () => {};
    vi.mocked(fetch).mockReturnValue(
      new Promise(resolve => {
        resolveFetch = resolve;
      }) as ReturnType<typeof fetch>,
    );

    // The catalog is expired and the refresh never resolves during the
    // request - the stale value must be served without waiting.
    await expect(
      resolveExchangeProvider("https://profiles.example/person/example"),
    ).resolves.toMatchObject({ id: "acme" });
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: false, status: 503 });
  });

  it("caches failed provider catalog lookups briefly", async () => {
    clearExchangeProvidersForTest();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(
      isExchangeSupportedUrl("https://profiles.example/person/example-person"),
    ).resolves.toBe(false);
    await expect(
      isExchangeSupportedUrl("https://profiles.example/person/example-person"),
    ).resolves.toBe(false);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("parses the provider catalog response", async () => {
    clearExchangeProvidersForTest();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: [
          {
            id: "acme",
            name: "Acme",
            description: "Structured records.",
            creditsCost: 12,
            terms: ACME_TERMS,
            capabilities: {
              scrape: {
                resourceTypes: ["records"],
                includes: [],
                urlRoutes: [
                  {
                    domains: ["Profiles.Example"],
                    pathPrefixes: ["person/"],
                  },
                ],
              },
            },
          },
          {
            id: "searchonly",
            name: "Search Only",
            description: "No scrape routes.",
            creditsCost: 0,
            capabilities: { search: { modes: ["semantic"] } },
          },
        ],
      }),
    } as unknown as Awaited<ReturnType<typeof fetch>>);

    await expect(
      resolveExchangeProvider("https://profiles.example/person/example"),
    ).resolves.toMatchObject({ id: "acme", terms: ACME_TERMS });
    await expect(
      resolveExchangeProvider("https://searchonly.example/anything"),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("builds a compact request log context", () => {
    expect(
      getExchangeRequestLogContext(
        "https://profiles.example/person/example-person/details/?trk=foo",
      ),
    ).toEqual({
      url: "https://profiles.example/person/example-person/details/?trk=foo",
      host: "profiles.example",
      pathPrefix: "person",
    });

    expect(getExchangeRequestLogContext("not a url")).toBeUndefined();
  });

  it("extracts response cache metadata for logs", () => {
    expect(
      getExchangeResponseLogContext({
        cacheState: "hit",
        cachedAt: "2026-06-21T10:00:00.000Z",
        cacheAgeMs: 1000,
        request_id: "req_123",
        extra: "ignored",
      }),
    ).toEqual({
      cacheState: "hit",
      cachedAt: "2026-06-21T10:00:00.000Z",
      cacheAgeMs: 1000,
      providerRequestId: "req_123",
    });

    expect(getExchangeResponseLogContext(null)).toEqual({});
  });

  it("accepts only formats the Exchange can return directly", () => {
    expect(isSupportedExchangeFormatRequest(undefined)).toBe(true);
    expect(isSupportedExchangeFormatRequest([{ type: "markdown" }])).toBe(
      true,
    );
    expect(isSupportedExchangeFormatRequest(["json"])).toBe(true);
    expect(
      isSupportedExchangeFormatRequest([
        { type: "markdown" },
        { type: "json" },
      ]),
    ).toBe(true);
    expect(isSupportedExchangeFormatRequest([{ type: "html" }])).toBe(false);
    expect(isSupportedExchangeFormatRequest([])).toBe(false);
  });

  it("allows eligible requests when access and terms are current", async () => {
    await expect(
      getExchangeAccessForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      provider: { id: "acme", creditsCost: 12 },
    });

    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "json" }],
        actions: [{ type: "wait" }],
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);

    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "json" }],
        zeroDataRetention: true,
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);
  });

  it("requires the provider's terms before routing", async () => {
    const access = await getExchangeAccessForRequest({
      url: "https://profiles.example/person/example-person",
      formats: [{ type: "markdown" }],
      flags: { professionalProfileCompanyDataBeta: true },
    });

    expect(access).toEqual({
      allowed: false,
      termsRequired: true,
      terms: ACME_TERMS,
    });

    expect(getThirdPartyDataTermsRequiredResponse(ACME_TERMS)).toMatchObject({
      success: false,
      code: "THIRD_PARTY_DATA_TERMS_REQUIRED",
      requiresAction: {
        type: "accept_terms",
        terms: "acme",
        version: "2026-01-01",
      },
    });
  });

  it("requires current terms when the accepted version is stale", async () => {
    await expect(
      getExchangeAccessForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: {
          professionalProfileCompanyDataBeta: true,
          organizationDataSourceAccess: {
            acme: {
              status: "enabled",
              termsKey: "acme",
              termsVersion: "2025-12-01",
            },
          },
        },
      }),
    ).resolves.toEqual({
      allowed: false,
      termsRequired: true,
      terms: ACME_TERMS,
    });
  });

  it("does not route or prompt for terms when access is disabled", async () => {
    await expect(
      getExchangeAccessForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: {
          professionalProfileCompanyDataBeta: true,
          organizationDataSourceAccess: {
            acme: {
              status: "disabled",
              termsKey: "acme",
              termsVersion: "2026-01-01",
              disabledAt: "2026-01-02T00:00:00.000Z",
              disabledReason: "customer_disabled",
            },
          },
        },
      }),
    ).resolves.toEqual({ allowed: false, termsRequired: false });
  });

  it("allows providers with no declared terms without acceptance", async () => {
    await expect(
      getExchangeAccessForRequest({
        url: "https://facts.example/records/1",
        formats: [{ type: "markdown" }],
        flags: { professionalProfileCompanyDataBeta: true },
      }),
    ).resolves.toMatchObject({ allowed: true, provider: { id: "openfacts" } });

    await expect(
      getExchangeAccessForRequest({
        url: "https://facts.example/records/1",
        formats: [{ type: "markdown" }],
        flags: {
          professionalProfileCompanyDataBeta: true,
          organizationDataSourceAccess: {
            openfacts: { status: "disabled" },
          },
        },
      }),
    ).resolves.toEqual({ allowed: false, termsRequired: false });
  });

  it("does not route unless the beta flag is enabled", async () => {
    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
      }),
    ).resolves.toBe(false);

    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: { professionalProfileCompanyDataBeta: false },
      }),
    ).resolves.toBe(false);
  });

  it("does not route unless the Exchange is configured", async () => {
    config.EXCHANGE_URL = undefined;

    await expect(
      canUseExchangeForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: ENABLED_EXCHANGE_FLAGS,
      }),
    ).resolves.toBe(false);
  });

  it("bills the reported credit cost only for successful handled responses", () => {
    expect(isSuccessfulExchangeStatusCode(200)).toBe(true);
    expect(isSuccessfulExchangeStatusCode(204)).toBe(true);
    expect(isSuccessfulExchangeStatusCode(304)).toBe(true);
    expect(isSuccessfulExchangeStatusCode(404)).toBe(false);

    expect(
      getExchangeSuccessCredits({
        exchange: { handled: true, creditsCost: 12 },
        statusCode: 200,
      }),
    ).toBe(12);

    expect(
      getExchangeSuccessCredits({
        exchange: { handled: true, creditsCost: 0 },
        statusCode: 304,
      }),
    ).toBe(0);

    expect(
      getExchangeSuccessCredits({
        exchange: { handled: true, creditsCost: 12 },
        statusCode: 404,
      }),
    ).toBeNull();

    expect(
      getExchangeSuccessCredits({
        statusCode: 200,
      }),
    ).toBeNull();
  });

  it("confirms billing without throwing on service failures", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
    } as Awaited<ReturnType<typeof fetch>>);

    await confirmExchangeBilling({
      accessEventId: "6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60",
      billingReference: "bill-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://exchange.example/v1/access-events/6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60/billing",
      expect.objectContaining({ method: "POST" }),
    );

    vi.mocked(fetch).mockRejectedValue(new Error("connect timeout"));
    await expect(
      confirmExchangeBilling({
        accessEventId: "6f1f5aab-3f78-4d0a-8a3d-2b1d3c4e5f60",
        billingReference: "bill-1",
      }),
    ).resolves.toBeUndefined();
  });
});
