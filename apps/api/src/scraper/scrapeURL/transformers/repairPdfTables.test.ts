import {
  repairConcatenatedTableHeaders,
  repairPdfTables,
} from "./repairPdfTables";

describe("repairConcatenatedTableHeaders", () => {
  it("splits a glued single-word paired-direction header", () => {
    const input = "| MANILA to BANGKOKBANGKOK to MANILA |  |  |  |";
    const output = repairConcatenatedTableHeaders(input);
    expect(output).toBe("| MANILA to BANGKOK | BANGKOK to MANILA |  |  |  |");
    expect(output).not.toContain("BANGKOKBANGKOK");
  });

  it("splits a glued multi-word location header", () => {
    const input = "| MANILA to BALI (Denpasar)BALI (Denpasar) to MANILA |  |";
    const output = repairConcatenatedTableHeaders(input);
    expect(output).toBe(
      "| MANILA to BALI (Denpasar) | BALI (Denpasar) to MANILA |  |",
    );
  });

  it("repairs multiple rows independently", () => {
    const input = [
      "| MANILA to BANGKOKBANGKOK to MANILA |  |",
      "| MANILA to CEBUCEBU to MANILA |  |",
    ].join("\n");
    const output = repairConcatenatedTableHeaders(input);
    expect(output).toBe(
      [
        "| MANILA to BANGKOK | BANGKOK to MANILA |  |",
        "| MANILA to CEBU | CEBU to MANILA |  |",
      ].join("\n"),
    );
  });

  it("leaves correctly separated headers untouched", () => {
    const input = "| MANILA to TAIPEI |  |  |  | TAIPEI to MANILA |  |  |  |";
    expect(repairConcatenatedTableHeaders(input)).toBe(input);
  });

  it("does not touch non-table prose even if it contains 'to'", () => {
    const input =
      "Travelers going from Manila to BangkokBangkok to Manila should rebook.";
    expect(repairConcatenatedTableHeaders(input)).toBe(input);
  });

  it("does not merge across an existing cell boundary", () => {
    // Two distinct cells that happen to look reversed must stay as-is: the
    // pipe between them prevents the [^|] groups from spanning columns.
    const input = "| MANILA to BANGKOK | BANGKOK to MANILA |";
    expect(repairConcatenatedTableHeaders(input)).toBe(input);
  });

  it("is a no-op when there is no ' to ' anywhere", () => {
    const input = "| PR 740 | Daily | 06:35 | 08:55 |";
    expect(repairConcatenatedTableHeaders(input)).toBe(input);
  });
});

describe("repairPdfTables transformer", () => {
  const baseMeta = () =>
    ({
      url: "https://example.com/timetable.pdf",
      rewrittenUrl: undefined,
      options: { formats: [{ type: "markdown" }] },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }) as any;

  const glued = "| MANILA to BANGKOKBANGKOK to MANILA |  |";

  it("repairs markdown when the source is a PDF (by contentType)", async () => {
    const doc: any = {
      markdown: glued,
      metadata: { contentType: "application/pdf", numPages: 4 },
    };
    const out = await repairPdfTables(baseMeta(), doc);
    expect(out.markdown).toContain("BANGKOK | BANGKOK");
  });

  it("repairs markdown when the URL ends in .pdf without metadata", async () => {
    const doc: any = { markdown: glued, metadata: {} };
    const out = await repairPdfTables(baseMeta(), doc);
    expect(out.markdown).toContain("BANGKOK | BANGKOK");
  });

  it("does not touch non-PDF documents", async () => {
    const meta = baseMeta();
    meta.url = "https://example.com/page.html";
    const doc: any = {
      markdown: glued,
      metadata: { contentType: "text/html" },
    };
    const out = await repairPdfTables(meta, doc);
    expect(out.markdown).toBe(glued);
  });

  it("is a no-op when there is no markdown", async () => {
    const doc: any = { metadata: { contentType: "application/pdf" } };
    const out = await repairPdfTables(baseMeta(), doc);
    expect(out.markdown).toBeUndefined();
  });
});
