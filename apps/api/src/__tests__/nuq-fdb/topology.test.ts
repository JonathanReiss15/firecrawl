import { describe, expect, test } from "vitest";
import { resolveNuqServiceTopology } from "../../services/worker/nuq-service-topology";

describe("NuQ service topology", () => {
  test("pg-only starts PG consumers and PG maintenance", () => {
    expect(
      resolveNuqServiceTopology({
        scrapeWorkerCount: 3,
      }),
    ).toEqual({
      forcedFdb: false,
      fdbConfigured: false,
      postgres: true,
      pgScrapeWorkers: 3,
      fdbScrapeWorkers: 0,
      pgPrefetch: true,
      pgReconciler: true,
      fdbMaintenance: false,
      fdbCrawlFinished: false,
    });
  });

  test("an FDB cluster file enables mixed PG and FDB consumers", () => {
    expect(
      resolveNuqServiceTopology({
        fdbClusterFile: "/etc/foundationdb/fdb.cluster",
        scrapeWorkerCount: 3,
      }),
    ).toEqual({
      forcedFdb: false,
      fdbConfigured: true,
      postgres: true,
      pgScrapeWorkers: 3,
      fdbScrapeWorkers: 3,
      pgPrefetch: true,
      pgReconciler: true,
      fdbMaintenance: true,
      fdbCrawlFinished: true,
    });
  });

  test("forced FDB starts no PG-only services", () => {
    expect(
      resolveNuqServiceTopology({
        backend: "fdb",
        scrapeWorkerCount: 3,
      }),
    ).toEqual({
      forcedFdb: true,
      fdbConfigured: true,
      postgres: false,
      pgScrapeWorkers: 0,
      fdbScrapeWorkers: 3,
      pgPrefetch: false,
      pgReconciler: false,
      fdbMaintenance: true,
      fdbCrawlFinished: true,
    });
  });

  test("FDB maintenance and completion remain enabled at zero scrape replicas", () => {
    const topology = resolveNuqServiceTopology({
      backend: "fdb",
      scrapeWorkerCount: 0,
    });

    expect(topology.fdbScrapeWorkers).toBe(0);
    expect(topology.fdbMaintenance).toBe(true);
    expect(topology.fdbCrawlFinished).toBe(true);
  });
});
