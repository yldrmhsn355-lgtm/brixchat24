import { describe, expect, it } from "vitest";
import {
  extractPositionalParameters,
  normalizeTemplateName,
  resolveTemplateVariables,
  selectTemplateLanguage,
  validateInternalVariableKey,
  validateTemplateComponents,
} from "./template-utils";

describe("WhatsApp template rules", () => {
  it("normalizes names without losing Turkish letters", () => {
    expect(normalizeTemplateName("  Randevu İptal / Ön Bilgi  ")).toBe(
      "randevu_iptal_on_bilgi",
    );
  });

  it("requires a body and rejects invalid component combinations", () => {
    expect(validateTemplateComponents([])).toContain(
      "template_body_required_once",
    );
    expect(
      validateTemplateComponents([
        { type: "HEADER", format: "IMAGE", text: "not allowed" },
        { type: "BODY", text: "Hello {{1}} and {{3}}" },
      ]),
    ).toEqual(
      expect.arrayContaining([
        "template_media_header_text_not_allowed",
        "template_body_parameters_not_sequential",
      ]),
    );
    expect(extractPositionalParameters("{{2}} {{1}} {{2}}")).toEqual([1, 2]);
  });

  it("accepts only supported internal variable roots", () => {
    expect(validateInternalVariableKey("contact.first_name")).toBe(true);
    expect(validateInternalVariableKey("bitrix.deal.UF_CRM_123")).toBe(true);
    expect(validateInternalVariableKey("secrets.access_token")).toBe(false);
  });

  it("applies explicit default and blocking policies", () => {
    const resolved = resolveTemplateVariables(
      [
        {
          component: "body",
          position: 1,
          internalKey: "contact.first_name",
          required: true,
          missingPolicy: "block",
        },
        {
          component: "body",
          position: 2,
          internalKey: "appointment.date",
          required: true,
          missingPolicy: "default",
          defaultValue: "Tarih daha sonra bildirilecek",
        },
      ],
      {},
    );
    expect(resolved.blocking).toEqual(["body.1"]);
    expect(resolved.values[1]).toMatchObject({
      source: "default",
      missing: false,
    });
  });

  it("never falls back silently", () => {
    const variants = [{ language: "tr" }, { language: "en_US" }];
    expect(selectTemplateLanguage(variants, "de", "en_US")).toEqual({
      variant: variants[1],
      fallbackUsed: true,
    });
    expect(selectTemplateLanguage(variants, "de", null)).toEqual({
      variant: null,
      fallbackUsed: false,
    });
  });
});
