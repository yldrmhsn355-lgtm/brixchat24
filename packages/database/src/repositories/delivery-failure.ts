export type DeliveryFailureCategory =
  | "recipient_unavailable"
  | "recipient_opted_out"
  | "provider_experiment"
  | "payment"
  | "service_window"
  | "media"
  | "rate_limit"
  | "channel_configuration"
  | "technical";

export type DeliveryFailureClassification = {
  errorCode: string;
  category: DeliveryFailureCategory;
  customerRelated: boolean;
  automationEligible: boolean;
  metaCode: number | null;
};

const metaCategories: Record<
  number,
  Omit<DeliveryFailureClassification, "errorCode" | "metaCode">
> = {
  130472: {
    category: "provider_experiment",
    customerRelated: true,
    automationEligible: true,
  },
  131026: {
    category: "recipient_unavailable",
    customerRelated: true,
    automationEligible: true,
  },
  131042: {
    category: "payment",
    customerRelated: false,
    automationEligible: false,
  },
  131047: {
    category: "service_window",
    customerRelated: false,
    automationEligible: false,
  },
  131050: {
    category: "recipient_opted_out",
    customerRelated: true,
    automationEligible: true,
  },
  131053: {
    category: "media",
    customerRelated: false,
    automationEligible: false,
  },
  131056: {
    category: "rate_limit",
    customerRelated: false,
    automationEligible: false,
  },
};

function numericMetaCode(
  errorCode: string | null | undefined,
  payload: Record<string, unknown> | undefined,
) {
  const direct = errorCode?.trim().match(/^META_(\d+)$/i)?.[1];
  if (direct) return Number(direct);
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  for (const error of errors) {
    if (!error || typeof error !== "object") continue;
    const code = (error as { code?: unknown }).code;
    if (
      (typeof code === "number" && Number.isInteger(code)) ||
      (typeof code === "string" && /^\d+$/.test(code))
    )
      return Number(code);
  }
  return null;
}

export function classifyDeliveryFailure(input: {
  errorCode?: string | null;
  payload?: Record<string, unknown>;
}): DeliveryFailureClassification {
  const metaCode = numericMetaCode(input.errorCode, input.payload);
  const meta = metaCode === null ? undefined : metaCategories[metaCode];
  if (meta)
    return {
      errorCode: `META_${metaCode}`,
      metaCode,
      ...meta,
    };

  const errorCode =
    (metaCode === null ? input.errorCode?.trim() : `META_${metaCode}`) ||
    "PROVIDER_DELIVERY_FAILED";
  const normalized = errorCode.toUpperCase();
  if (
    normalized === "WHATSAPP_WEB_RECIPIENT_INVALID" ||
    /RECIPIENT_(?:NOT_)?(?:AVAILABLE|INVALID|UNAVAILABLE)/.test(normalized)
  )
    return {
      errorCode,
      category: "recipient_unavailable",
      customerRelated: true,
      automationEligible: true,
      metaCode,
    };
  if (/MEDIA|ATTACHMENT|MIME/.test(normalized))
    return {
      errorCode,
      category: "media",
      customerRelated: false,
      automationEligible: false,
      metaCode,
    };
  if (/AUTH|CREDENTIAL|PERMISSION|CONFIGURATION/.test(normalized))
    return {
      errorCode,
      category: "channel_configuration",
      customerRelated: false,
      automationEligible: false,
      metaCode,
    };
  if (/RATE|THROTTL|LIMIT/.test(normalized))
    return {
      errorCode,
      category: "rate_limit",
      customerRelated: false,
      automationEligible: false,
      metaCode,
    };
  return {
    errorCode,
    category: "technical",
    customerRelated: false,
    automationEligible: false,
    metaCode,
  };
}
