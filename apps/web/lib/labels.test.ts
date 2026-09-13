import { describe, expect, it } from "vitest";
import {
  canCreateWorkspaceLabels,
  canManageLabels,
  labelTextColor,
  normalizeLabelName,
} from "./labels";

describe("label management permissions", () => {
  it.each(["owner", "admin", "team_lead"])(
    "allows %s to manage labels",
    (role) => expect(canManageLabels(role)).toBe(true),
  );

  it.each(["agent", "viewer", null, undefined])(
    "keeps %s in read-only mode",
    (role) => expect(canManageLabels(role)).toBe(false),
  );
});

describe("label utilities", () => {
  it("normalizes Turkish label names and whitespace", () => {
    expect(normalizeLabelName("  İLGİLİ   Müşteri ")).toBe("ilgili müşteri");
  });

  it("selects the higher contrast badge text color", () => {
    expect(labelTextColor("#ffffff")).toBe("#111827");
    expect(labelTextColor("#111827")).toBe("#ffffff");
  });

  it("limits workspace label creation to owners and admins", () => {
    expect(canCreateWorkspaceLabels("admin")).toBe(true);
    expect(canCreateWorkspaceLabels("team_lead")).toBe(false);
  });
});
