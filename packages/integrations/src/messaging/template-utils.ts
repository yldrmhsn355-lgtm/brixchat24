export type TemplateComponentType = "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
export type TemplateHeaderFormat =
  | "TEXT"
  | "IMAGE"
  | "VIDEO"
  | "DOCUMENT"
  | "LOCATION";
export type MissingVariablePolicy = "block" | "default" | "manual";

export interface TemplateComponentDraft {
  type: TemplateComponentType;
  format?: TemplateHeaderFormat;
  text?: string;
  example?: Record<string, unknown>;
  buttons?: Array<Record<string, unknown>>;
}

export interface TemplateVariableMapping {
  component: string;
  position: number;
  internalKey: string;
  exampleValue?: string;
  defaultValue?: string;
  formatter?: "text" | "date" | "time" | "phone" | "currency";
  required: boolean;
  missingPolicy: MissingVariablePolicy;
}

export interface ResolvedTemplateVariable {
  key: string;
  value?: string;
  source: "context" | "default" | "manual";
  missing: boolean;
}

const allowedInternalRoots = new Set([
  "contact",
  "appointment",
  "assigned_user",
  "workspace",
  "bitrix",
]);

export function normalizeTemplateName(value: string): string {
  return value
    .trim()
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function validateTemplateName(value: string): string[] {
  const normalized = normalizeTemplateName(value);
  const errors: string[] = [];
  if (!normalized) errors.push("template_name_required");
  if (normalized.length > 512) errors.push("template_name_too_long");
  if (value !== normalized) errors.push("template_name_not_normalized");
  return errors;
}

export function extractPositionalParameters(text: string): number[] {
  return [
    ...new Set(
      [...text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1])),
    ),
  ].sort((left, right) => left - right);
}

export function validateTemplateComponents(
  components: TemplateComponentDraft[],
): string[] {
  const errors: string[] = [];
  const count = (type: TemplateComponentType) =>
    components.filter((component) => component.type === type).length;
  if (count("BODY") !== 1) errors.push("template_body_required_once");
  for (const type of ["HEADER", "FOOTER", "BUTTONS"] as const)
    if (count(type) > 1)
      errors.push(`template_${type.toLowerCase()}_duplicate`);

  const header = components.find((component) => component.type === "HEADER");
  if (header) {
    if (!header.format) errors.push("template_header_format_required");
    if (header.format === "TEXT" && !header.text?.trim())
      errors.push("template_header_text_required");
    if (header.format !== "TEXT" && header.text?.trim())
      errors.push("template_media_header_text_not_allowed");
  }

  const body = components.find((component) => component.type === "BODY");
  if (!body?.text?.trim()) errors.push("template_body_text_required");
  if ((body?.text?.length ?? 0) > 1024) errors.push("template_body_too_long");
  if ((header?.text?.length ?? 0) > 60) errors.push("template_header_too_long");
  const footer = components.find((component) => component.type === "FOOTER");
  if ((footer?.text?.length ?? 0) > 60) errors.push("template_footer_too_long");

  for (const component of components) {
    const positions = extractPositionalParameters(component.text ?? "");
    positions.forEach((position, index) => {
      if (position !== index + 1)
        errors.push(
          `template_${component.type.toLowerCase()}_parameters_not_sequential`,
        );
    });
  }
  return [...new Set(errors)];
}

export function validateInternalVariableKey(key: string): boolean {
  const [root, ...rest] = key.split(".");
  return Boolean(
    root &&
      rest.length > 0 &&
      allowedInternalRoots.has(root) &&
      rest.every((part) => /^[a-zA-Z0-9_*]+$/.test(part)),
  );
}

function formatValue(
  value: unknown,
  formatter: TemplateVariableMapping["formatter"],
  locale = "tr-TR",
): string {
  if (value === null || value === undefined) return "";
  if (formatter === "date") {
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime())
      ? String(value)
      : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed);
  }
  if (formatter === "time") {
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime())
      ? String(value)
      : new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(parsed);
  }
  if (formatter === "phone") return String(value).replace(/[^\d+]/g, "");
  return String(value);
}

export function resolveTemplateVariables(
  mappings: TemplateVariableMapping[],
  context: Record<string, unknown>,
  manual: Record<string, string> = {},
): { values: ResolvedTemplateVariable[]; blocking: string[] } {
  const values = mappings
    .slice()
    .sort(
      (left, right) =>
        left.component.localeCompare(right.component) ||
        left.position - right.position,
    )
    .map((mapping): ResolvedTemplateVariable => {
      const contextValue = context[mapping.internalKey];
      if (contextValue !== undefined && contextValue !== null)
        return {
          key: `${mapping.component}.${mapping.position}`,
          value: formatValue(contextValue, mapping.formatter),
          source: "context",
          missing: false,
        };
      if (manual[mapping.internalKey]?.trim())
        return {
          key: `${mapping.component}.${mapping.position}`,
          value: manual[mapping.internalKey]!.trim(),
          source: "manual",
          missing: false,
        };
      if (
        mapping.missingPolicy === "default" &&
        mapping.defaultValue?.trim()
      )
        return {
          key: `${mapping.component}.${mapping.position}`,
          value: mapping.defaultValue.trim(),
          source: "default",
          missing: false,
        };
      return {
        key: `${mapping.component}.${mapping.position}`,
        source: "manual",
        missing: mapping.required || mapping.missingPolicy === "block",
      };
    });
  return {
    values,
    blocking: values.filter((value) => value.missing).map((value) => value.key),
  };
}

export function selectTemplateLanguage<T extends { language: string }>(
  variants: T[],
  preferredLanguage: string | null,
  fallbackLanguage: string | null,
): { variant: T | null; fallbackUsed: boolean } {
  const preferred = preferredLanguage
    ? variants.find((variant) => variant.language === preferredLanguage)
    : undefined;
  if (preferred) return { variant: preferred, fallbackUsed: false };
  const fallback = fallbackLanguage
    ? variants.find((variant) => variant.language === fallbackLanguage)
    : undefined;
  return { variant: fallback ?? null, fallbackUsed: Boolean(fallback) };
}
