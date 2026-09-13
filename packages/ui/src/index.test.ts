import { describe, expect, it } from "vitest";
import { Badge, cx, Input, Status, Surface } from "./index";

describe("cx", () => {
  it("joins only active class names", () => {
    expect(cx("ui-button", false, undefined, "is-active", null)).toBe(
      "ui-button is-active",
    );
  });

  it("keeps premium primitives on stable semantic class contracts", () => {
    expect(Input).toBeTruthy();
    expect(Surface({ children: "İçerik", tone: "glass" }).props.className).toBe(
      "ui-surface ui-surface-glass",
    );
    expect(Status({ children: "Bağlı", tone: "success" }).props.className).toBe(
      "ui-status ui-status-success",
    );
    expect(Badge({ children: "Yeni", tone: "brand" }).props.className).toBe(
      "ui-badge ui-badge-brand",
    );
  });
});
