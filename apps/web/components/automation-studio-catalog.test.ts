import { describe, expect, it } from "vitest";
import { buildStudioPalette } from "./automation-studio-catalog";

const nodes = [
  {
    type: "message.received",
    version: 1,
    displayName: "Mesaj alındı",
    description: "Inbound message",
    category: "trigger",
    availability: "available",
    runtimeCapability: "production",
  },
  {
    type: "wait.duration",
    version: 1,
    displayName: "Süre bekle",
    description: "Durable continuation",
    category: "time",
    availability: "planned",
    runtimeCapability: "planned",
  },
];

describe("Automation Studio registry palette", () => {
  it("maps registry categories and disables non-production definitions", () => {
    const palette = buildStudioPalette(nodes, "");

    expect(palette).toEqual([
      expect.objectContaining({
        title: "Tetikleyiciler",
        category: "trigger",
        items: [
          expect.objectContaining({
            type: "message.received",
            disabled: false,
          }),
        ],
      }),
      expect.objectContaining({
        title: "Zaman ve SLA",
        category: "delay",
        items: [
          expect.objectContaining({
            type: "wait.duration",
            disabled: true,
          }),
        ],
      }),
    ]);
  });

  it("searches localized labels and descriptions", () => {
    expect(buildStudioPalette(nodes, "süre")).toHaveLength(1);
    expect(buildStudioPalette(nodes, "süre")[0]?.items[0]?.type).toBe(
      "wait.duration",
    );
  });
});
