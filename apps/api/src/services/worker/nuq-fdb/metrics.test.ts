import { afterEach, describe, expect, test, vi } from "vitest";
import { encodeI64, METRIC_SHARDS } from "./keyspace";
import { crawlFinishedQueueFdb, nuqFdbGetMetrics, scrapeQueueFdb } from ".";
import { NuQFdbQueue, NuqFdbMetricsInitializingError } from "./queue";

const READINESS = `# HELP firecrawl_nuq_fdb_metrics_ready Whether maintained FDB queue metrics are fully initialized
# TYPE firecrawl_nuq_fdb_metrics_ready gauge
`;

const SCRAPE_METRICS = `# HELP nuq_fdb_queue_scrape_job_count Number of FDB jobs in each status
# TYPE nuq_fdb_queue_scrape_job_count gauge
nuq_fdb_queue_scrape_job_count{status="queued"} 2
nuq_fdb_queue_scrape_job_count{status="active"} 3
nuq_fdb_queue_scrape_job_count{status="completed"} 0
nuq_fdb_queue_scrape_job_count{status="failed"} 0
nuq_fdb_queue_scrape_job_count{status="backlog"} 4
`;

const CRAWL_FINISHED_METRICS = `# HELP nuq_fdb_queue_crawl_finished_job_count Number of FDB jobs in each status
# TYPE nuq_fdb_queue_crawl_finished_job_count gauge
nuq_fdb_queue_crawl_finished_job_count{status="queued"} 7
nuq_fdb_queue_crawl_finished_job_count{status="active"} 0
nuq_fdb_queue_crawl_finished_job_count{status="completed"} 0
nuq_fdb_queue_crawl_finished_job_count{status="failed"} 0
nuq_fdb_queue_crawl_finished_job_count{status="backlog"} 0
`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NuQ FDB metrics", () => {
  test("queue output has an exact fixed-width read footprint", async () => {
    const queue = new NuQFdbQueue("scrape", { hasGroups: false });
    let queueCardinality = 1;
    let initialized = true;
    const get = vi.fn(async (key: Buffer) => {
      const [, , family, status, shard] = queue.ks.unpack(key);
      if (
        family === "mn-backfill" &&
        (status === "active-v2" || status === "done")
      ) {
        return initialized ? Buffer.from("generation") : undefined;
      }
      if (family !== "mn" || shard !== 0) return undefined;
      if (status === "queued") return encodeI64(2);
      if (status === "active") return encodeI64(3);
      if (status === "pending") return encodeI64(4);
      return undefined;
    });
    // This models the unbounded queue data a range scan would encounter. The
    // collector must never invoke it, at either cardinality.
    const getRangeAll = vi.fn(async () =>
      Array.from({ length: queueCardinality }, () => [
        Buffer.alloc(0),
        Buffer.alloc(0),
      ]),
    );
    const snapshot = () => ({ get, getRangeAll });
    Object.defineProperty(queue, "db", {
      value: {
        doTn: async (fn: (tn: unknown) => unknown) => fn({ snapshot }),
      },
    });

    expect(await queue.getMetrics()).toBe(SCRAPE_METRICS);
    expect(get).toHaveBeenCalledTimes(3 * METRIC_SHARDS + 2);
    expect(getRangeAll).not.toHaveBeenCalled();

    get.mockClear();
    getRangeAll.mockClear();
    queueCardinality = 1_000_000;

    expect(await queue.getMetrics()).toBe(SCRAPE_METRICS);
    expect(get).toHaveBeenCalledTimes(3 * METRIC_SHARDS + 2);
    expect(getRangeAll).not.toHaveBeenCalled();

    get.mockClear();
    initialized = false;
    await expect(queue.getMetrics()).rejects.toThrow(
      "NuQ FDB metrics are initializing",
    );
    expect(get).toHaveBeenCalledTimes(3 * METRIC_SHARDS + 2);
    expect(getRangeAll).not.toHaveBeenCalled();
  });

  test("exported collector composes both exact queue families", async () => {
    vi.spyOn(scrapeQueueFdb, "getMetrics").mockResolvedValue(SCRAPE_METRICS);
    vi.spyOn(crawlFinishedQueueFdb, "getMetrics").mockResolvedValue(
      CRAWL_FINISHED_METRICS,
    );
    vi.spyOn(scrapeQueueFdb, "getWorkerLoadCount").mockResolvedValue(5);

    await expect(nuqFdbGetMetrics()).resolves
      .toBe(`${READINESS}firecrawl_nuq_fdb_metrics_ready 1
${SCRAPE_METRICS}${CRAWL_FINISHED_METRICS}# HELP firecrawl_nuq_fdb_pending_jobs Number of FDB scrape jobs currently admitted to workers or waiting in ready shards
# TYPE firecrawl_nuq_fdb_pending_jobs gauge
firecrawl_nuq_fdb_pending_jobs 5
`);
  });

  test("exported collector remains scrapeable while counters initialize", async () => {
    vi.spyOn(scrapeQueueFdb, "getMetrics").mockRejectedValue(
      new NuqFdbMetricsInitializingError("initializing"),
    );
    vi.spyOn(crawlFinishedQueueFdb, "getMetrics").mockResolvedValue(
      CRAWL_FINISHED_METRICS,
    );
    vi.spyOn(scrapeQueueFdb, "getWorkerLoadCount").mockResolvedValue(5);

    await expect(nuqFdbGetMetrics()).resolves.toBe(
      `${READINESS}firecrawl_nuq_fdb_metrics_ready 0\n`,
    );
  });
});
