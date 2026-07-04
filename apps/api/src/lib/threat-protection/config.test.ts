import {
  ALPHAMOUNTAIN_CATEGORIES,
  DEFAULT_DENIED_CATEGORIES,
  threatProtectionConfigSchema,
  threatProtectionPolicySchema,
} from "./config";
import { THREAT_PROTECTION_POLICY_DEFAULTS } from "./types";

describe("threatProtectionPolicySchema", () => {
  it("applies defaults for a minimal document", () => {
    const policy = threatProtectionPolicySchema.parse({ mode: "off" });
    expect(policy).toEqual({
      mode: "off",
      ...THREAT_PROTECTION_POLICY_DEFAULTS,
    });
  });

  it("accepts a full valid document", () => {
    const policy = threatProtectionPolicySchema.parse({
      mode: "enhanced",
      riskScoreThreshold: 50,
      deniedCategories: ["Malicious", "Phishing", "Gambling"],
      maxDomainAgeDays: 30,
      blacklist: ["bad.example.com", "*.malware.example"],
      whitelist: ["example.com", "*.example.org"],
      blockedTlds: ["zip", "mov"],
      blockedCountries: ["KP", "IR"],
      failurePolicy: "open",
    });
    expect(policy.mode).toBe("enhanced");
    expect(policy.riskScoreThreshold).toBe(50);
    expect(policy.maxDomainAgeDays).toBe(30);
    expect(policy.failurePolicy).toBe("open");
  });

  it("rejects an invalid mode", () => {
    expect(() =>
      threatProtectionPolicySchema.parse({ mode: "paranoid" }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      threatProtectionPolicySchema.parse({ mode: "off", nope: true }),
    ).toThrow();
  });

  describe("riskScoreThreshold", () => {
    it.each([0, 100, 75])("accepts %d", value => {
      expect(
        threatProtectionPolicySchema.parse({
          mode: "normal",
          riskScoreThreshold: value,
        }).riskScoreThreshold,
      ).toBe(value);
    });

    it.each([-1, 101, 50.5])("rejects %d", value => {
      expect(() =>
        threatProtectionPolicySchema.parse({
          mode: "normal",
          riskScoreThreshold: value,
        }),
      ).toThrow();
    });
  });

  describe("blacklist / whitelist globs", () => {
    it("normalizes case and whitespace", () => {
      const policy = threatProtectionPolicySchema.parse({
        mode: "normal",
        blacklist: ["  Bad.Example.COM ", "*.Evil.Example"],
      });
      expect(policy.blacklist).toEqual(["bad.example.com", "*.evil.example"]);
    });

    it.each([
      "https://example.com",
      "example.com/path",
      "example.com:8080",
      "*.",
      "*",
      "*.*.example.com",
      "foo",
      "ex ample.com",
      "-bad-.example.com",
      "exa_mple.com",
    ])("rejects garbage entry %j with a clear message", entry => {
      expect(() =>
        threatProtectionPolicySchema.parse({
          mode: "normal",
          blacklist: [entry],
        }),
      ).toThrow(/Invalid domain entry/);
    });
  });

  describe("blockedTlds", () => {
    it("accepts and normalizes TLDs", () => {
      const policy = threatProtectionPolicySchema.parse({
        mode: "normal",
        blockedTlds: ["ZIP", " mov "],
      });
      expect(policy.blockedTlds).toEqual(["zip", "mov"]);
    });

    it.each([".zip", "z!p", "co.uk", ""])("rejects %j", entry => {
      expect(() =>
        threatProtectionPolicySchema.parse({
          mode: "normal",
          blockedTlds: [entry],
        }),
      ).toThrow(/Invalid TLD/);
    });
  });

  describe("blockedCountries", () => {
    it("accepts and uppercases alpha-2 codes", () => {
      const policy = threatProtectionPolicySchema.parse({
        mode: "enhanced",
        blockedCountries: ["us", "KP"],
      });
      expect(policy.blockedCountries).toEqual(["US", "KP"]);
    });

    it.each(["USA", "U", "1A", ""])("rejects %j", entry => {
      expect(() =>
        threatProtectionPolicySchema.parse({
          mode: "enhanced",
          blockedCountries: [entry],
        }),
      ).toThrow(/Invalid country code/);
    });
  });

  describe("deniedCategories", () => {
    it("accepts known alphaMountain categories", () => {
      const policy = threatProtectionPolicySchema.parse({
        mode: "enhanced",
        deniedCategories: ["Malicious", "Scam/Illegal/Unethical"],
      });
      expect(policy.deniedCategories).toEqual([
        "Malicious",
        "Scam/Illegal/Unethical",
      ]);
    });

    it.each(["Botnets", "malicious", "Totally Made Up"])(
      "rejects unknown category %j",
      entry => {
        expect(() =>
          threatProtectionPolicySchema.parse({
            mode: "enhanced",
            deniedCategories: [entry],
          }),
        ).toThrow(/Unknown content category/);
      },
    );
  });

  describe("maxDomainAgeDays", () => {
    it("accepts null and positive integers", () => {
      expect(
        threatProtectionPolicySchema.parse({
          mode: "enhanced",
          maxDomainAgeDays: null,
        }).maxDomainAgeDays,
      ).toBeNull();
      expect(
        threatProtectionPolicySchema.parse({
          mode: "enhanced",
          maxDomainAgeDays: 90,
        }).maxDomainAgeDays,
      ).toBe(90);
    });

    it.each([0, -5, 2.5])("rejects %d", value => {
      expect(() =>
        threatProtectionPolicySchema.parse({
          mode: "enhanced",
          maxDomainAgeDays: value,
        }),
      ).toThrow();
    });
  });
});

describe("threatProtectionConfigSchema", () => {
  it("applies defaults for allowRequestOverrides and siem", () => {
    const config = threatProtectionConfigSchema.parse({ mode: "normal" });
    expect(config.allowRequestOverrides).toBe(true);
    expect(config.siem).toBeNull();
  });

  it("accepts a SIEM config", () => {
    const config = threatProtectionConfigSchema.parse({
      mode: "normal",
      siem: {
        url: "https://siem.example.com/ingest",
        secret: "hunter2hunter2",
        events: "all",
      },
    });
    expect(config.siem).toEqual({
      url: "https://siem.example.com/ingest",
      secret: "hunter2hunter2",
      events: "all",
    });
  });

  it("defaults SIEM events to blocked and secret to null", () => {
    const config = threatProtectionConfigSchema.parse({
      mode: "normal",
      siem: { url: "https://siem.example.com/ingest" },
    });
    expect(config.siem?.events).toBe("blocked");
    expect(config.siem?.secret).toBeNull();
  });

  it("rejects non-http(s) SIEM urls", () => {
    expect(() =>
      threatProtectionConfigSchema.parse({
        mode: "normal",
        siem: { url: "ftp://siem.example.com" },
      }),
    ).toThrow();
    expect(() =>
      threatProtectionConfigSchema.parse({
        mode: "normal",
        siem: { url: "not a url" },
      }),
    ).toThrow();
  });

  it("rejects invalid siem events values", () => {
    expect(() =>
      threatProtectionConfigSchema.parse({
        mode: "normal",
        siem: { url: "https://siem.example.com", events: "everything" },
      }),
    ).toThrow();
  });
});

describe("category constants", () => {
  it("DEFAULT_DENIED_CATEGORIES only contains known categories", () => {
    const known = new Set<string>(ALPHAMOUNTAIN_CATEGORIES);
    for (const category of DEFAULT_DENIED_CATEGORIES) {
      expect(known.has(category)).toBe(true);
    }
  });

  it("DEFAULT_DENIED_CATEGORIES validates against the schema", () => {
    const policy = threatProtectionPolicySchema.parse({
      mode: "enhanced",
      deniedCategories: DEFAULT_DENIED_CATEGORIES,
    });
    expect(policy.deniedCategories).toEqual(DEFAULT_DENIED_CATEGORIES);
  });
});
