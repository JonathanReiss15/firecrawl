import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../config";
import {
  canUseDataLayerForRequest,
  clearDataLayerCapabilitiesForTest,
  getDataLayerAccessForRequest,
  getDataLayerRequestLogContext,
  getDataLayerResponseLogContext,
  getDataLayerSuccessCredits,
  getThirdPartyDataTermsRequiredResponse,
  isDataLayerSupportedUrl,
  isSuccessfulDataLayerStatusCode,
  isSupportedDataLayerFormatRequest,
  setDataLayerCapabilitiesForTest,
} from "./data-layer";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

const originalConfig = {
  FIRE_ENGINE_BETA_URL: config.FIRE_ENGINE_BETA_URL,
};
const ENABLED_DATA_LAYER_FLAGS = {
  professionalProfileCompanyDataBeta: true,
  acceptedDataSourceTerms: {
    professional_profile_company_data: ["2026-07-03"],
  },
};

describe("data layer routing", () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    config.FIRE_ENGINE_BETA_URL = "https://fire-engine.example";
    setDataLayerCapabilitiesForTest({
      domains: ["profiles.example"],
      baseDomains: ["network.example"],
    });
  });

  afterEach(() => {
    config.FIRE_ENGINE_BETA_URL = originalConfig.FIRE_ENGINE_BETA_URL;
    clearDataLayerCapabilitiesForTest();
  });

  it("detects URLs using Fire Engine capabilities", async () => {
    await expect(
      isDataLayerSupportedUrl(
        "https://profiles.example/person/example-person/details/experience/?trk=foo",
      ),
    ).resolves.toBe(true);
    await expect(
      isDataLayerSupportedUrl("https://www.network.example/any/path"),
    ).resolves.toBe(true);
    await expect(
      isDataLayerSupportedUrl("https://other.example/person/example-person"),
    ).resolves.toBe(false);
    await expect(isDataLayerSupportedUrl("not a url")).resolves.toBe(false);
  });

  it("caches failed Fire Engine capabilities lookups briefly", async () => {
    clearDataLayerCapabilitiesForTest();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(
      isDataLayerSupportedUrl("https://profiles.example/person/example-person"),
    ).resolves.toBe(false);
    await expect(
      isDataLayerSupportedUrl("https://profiles.example/person/example-person"),
    ).resolves.toBe(false);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("builds a compact request log context", () => {
    expect(
      getDataLayerRequestLogContext(
        "https://profiles.example/person/example-person/details/experience/?trk=foo",
      ),
    ).toEqual({
      url: "https://profiles.example/person/example-person/details/experience/?trk=foo",
      host: "profiles.example",
      pathPrefix: "person",
    });

    expect(getDataLayerRequestLogContext("not a url")).toBeUndefined();
  });

  it("extracts response cache metadata for logs", () => {
    expect(
      getDataLayerResponseLogContext({
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

    expect(getDataLayerResponseLogContext(null)).toEqual({});
  });

  it("accepts only formats that Fire Engine can return directly", () => {
    expect(isSupportedDataLayerFormatRequest(undefined)).toBe(true);
    expect(isSupportedDataLayerFormatRequest([{ type: "markdown" }])).toBe(
      true,
    );
    expect(isSupportedDataLayerFormatRequest(["json"])).toBe(true);
    expect(
      isSupportedDataLayerFormatRequest([
        { type: "markdown" },
        { type: "json" },
      ]),
    ).toBe(true);
    expect(isSupportedDataLayerFormatRequest([{ type: "html" }])).toBe(false);
    expect(isSupportedDataLayerFormatRequest([])).toBe(false);
  });

  it("allows eligible requests through the blocklist when the org data source beta flag is enabled", async () => {
    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: ENABLED_DATA_LAYER_FLAGS,
      }),
    ).resolves.toBe(true);

    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "json" }],
        actions: [{ type: "wait" }],
        flags: ENABLED_DATA_LAYER_FLAGS,
      }),
    ).resolves.toBe(false);

    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "json" }],
        zeroDataRetention: true,
        flags: ENABLED_DATA_LAYER_FLAGS,
      }),
    ).resolves.toBe(false);
  });

  it("requires current Third-Party Data terms before routing", async () => {
    await expect(
      getDataLayerAccessForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: { professionalProfileCompanyDataBeta: true },
      }),
    ).resolves.toEqual({ allowed: false, termsRequired: true });

    expect(getThirdPartyDataTermsRequiredResponse()).toMatchObject({
      success: false,
      code: "THIRD_PARTY_DATA_TERMS_REQUIRED",
      requiresAction: {
        type: "accept_terms",
        terms: "professional_profile_company_data",
        version: "2026-07-03",
      },
    });

    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: { professionalProfileCompanyDataBeta: true },
      }),
    ).resolves.toBe(false);

    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: { professionalProfileCompanyDataBeta: true },
      }),
    ).resolves.toBe(false);
  });

  it("uses accepted data source terms from the auth chunk flags", async () => {
    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: {
          professionalProfileCompanyDataBeta: true,
          acceptedDataSourceTerms: {
            professional_profile_company_data: ["2026-07-03"],
          },
        },
      }),
    ).resolves.toBe(true);

    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: {
          professionalProfileCompanyDataBeta: true,
          acceptedDataSourceTerms: {
            professional_profile_company_data: ["2026-07-02"],
          },
        },
      }),
    ).resolves.toBe(false);
  });

  it("does not bypass unless the org data source beta flag is enabled", async () => {
    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
      }),
    ).resolves.toBe(false);

    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: { professionalProfileCompanyDataBeta: false },
      }),
    ).resolves.toBe(false);
  });

  it("does not bypass unless Fire Engine is configured", async () => {
    config.FIRE_ENGINE_BETA_URL = undefined;

    await expect(
      canUseDataLayerForRequest({
        url: "https://profiles.example/person/example-person",
        formats: [{ type: "markdown" }],
        flags: ENABLED_DATA_LAYER_FLAGS,
      }),
    ).resolves.toBe(false);
  });

  it("returns 15 credits only for successful handled responses", () => {
    expect(isSuccessfulDataLayerStatusCode(200)).toBe(true);
    expect(isSuccessfulDataLayerStatusCode(204)).toBe(true);
    expect(isSuccessfulDataLayerStatusCode(304)).toBe(true);
    expect(isSuccessfulDataLayerStatusCode(404)).toBe(false);

    expect(
      getDataLayerSuccessCredits({
        dataLayer: { handled: true, integrationId: "example" },
        statusCode: 200,
      }),
    ).toBe(15);

    expect(
      getDataLayerSuccessCredits({
        dataLayer: { handled: true, integrationId: "example" },
        statusCode: 304,
      }),
    ).toBe(15);

    expect(
      getDataLayerSuccessCredits({
        dataLayer: { handled: true, integrationId: "example" },
        statusCode: 404,
      }),
    ).toBeNull();

    expect(
      getDataLayerSuccessCredits({
        statusCode: 200,
      }),
    ).toBeNull();
  });
});
