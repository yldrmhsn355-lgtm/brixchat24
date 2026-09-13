import { describe, expect, it } from "vitest";
import { normalizeCampaignPhone, previewCampaignCsv } from "./campaigns";

describe("campaign CSV preview", () => {
  it("normalizes explicit international numbers without inventing a country", () => {
    expect(normalizeCampaignPhone("0090 (555) 123-4567")).toBe("+905551234567");
    expect(normalizeCampaignPhone("05551234567")).toBeNull();
    expect(normalizeCampaignPhone("=HYPERLINK(123)")).toBeNull();
  });
  it("supports Turkish headers, BOM, semicolons and normalized deduplication", () => {
    expect(
      previewCampaignCsv(
        "\uFEFFtelefon;isim\r\n+905551234567;Ayşe\r\n00905551234567;Aynı kişi\r\n",
      ),
    ).toEqual({
      recipients: [{ phone: "+905551234567", name: "Ayşe" }],
      duplicates: 1,
      errors: [],
    });
  });
  it("handles commas, escaped quotes and newlines inside quoted names", () => {
    expect(
      previewCampaignCsv('phone,name\n+15551234567,"Ada, ""A""\nSmith"')
        .recipients[0]?.name,
    ).toBe('Ada, "A"\nSmith');
  });
  it("reports invalid rows without silently turning them into recipients", () => {
    const result = previewCampaignCsv(
      "phone,name\n123,A\n+15551234567,B,extra\n+15551234568,C",
    );
    expect(result.errors.map((error) => error.row)).toEqual([2, 3]);
    expect(result.recipients).toHaveLength(1);
  });
  it("rejects ambiguous or malformed CSV", () => {
    for (const source of [
      'phone,name\n+15551234567,"A',
      'phone,name\n+15551234567,"A"x',
      "name\nA",
    ]) {
      expect(() => previewCampaignCsv(source)).toThrow();
    }
  });
  it("enforces a bounded import before constructing a campaign", () => {
    expect(() =>
      previewCampaignCsv("phone\n" + "+15551234567\n".repeat(1001)),
    ).toThrow("1000");
    expect(() => previewCampaignCsv("x".repeat(1_000_001))).toThrow("1 MB");
  });
});
