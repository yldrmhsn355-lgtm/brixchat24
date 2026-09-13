import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type PaddleEnvironment = "sandbox" | "production";

export type PaddleConfig = {
  apiKey: string;
  clientToken: string;
  webhookSecret: string;
  environment: PaddleEnvironment;
  checkoutUrl: string;
};

const paddleEnvelopeSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.coerce.date(),
  data: z.record(z.string(), z.unknown()),
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length ? value : null;
const asDate = (value: unknown): Date | null => {
  const string = asString(value);
  if (!string) return null;
  const date = new Date(string);
  return Number.isNaN(date.getTime()) ? null : date;
};
const asMinor = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) ? number : 0;
};

export function verifyPaddleSignature(input: {
  rawBody: string;
  signature: string | undefined;
  secret: string;
  now?: number;
  toleranceSeconds?: number;
}): boolean {
  if (!input.signature || !input.secret) return false;
  const parts = input.signature
    .split(";")
    .reduce<Record<string, string[]>>((result, part) => {
      const [key, value] = part.trim().split("=", 2);
      if (key && value) (result[key] ??= []).push(value);
      return result;
    }, {});
  const timestamp = Number(parts.ts?.[0]);
  const signatures = parts.h1 ?? [];
  if (!Number.isFinite(timestamp) || !signatures.length) return false;
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > (input.toleranceSeconds ?? 300))
    return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}:${input.rawBody}`)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature, "hex");
    return (
      actual.length === expectedBuffer.length &&
      timingSafeEqual(actual, expectedBuffer)
    );
  });
}

export type NormalizedPaddleWebhook = {
  eventId: string;
  eventType: string;
  occurredAt: Date;
  organizationId: string | null;
  subscription?: {
    customerRef?: string | null;
    subscriptionRef: string;
    planCode?: string | null;
    status:
      "trialing" | "active" | "past_due" | "paused" | "canceled" | "incomplete";
    periodStart?: Date | null;
    periodEnd?: Date | null;
    graceEndsAt?: Date | null;
    cancelAtPeriodEnd?: boolean;
    items?: Array<{
      providerPriceRef: string;
      providerItemRef?: string | null;
      quantity: number;
    }>;
  };
  transaction?: {
    transactionRef: string;
    status:
      | "draft"
      | "ready"
      | "billed"
      | "paid"
      | "past_due"
      | "canceled"
      | "failed";
    currency: string;
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    invoiceNumber?: string | null;
    billedAt?: Date | null;
  };
  creditPurchase?: { entryKey: string; amount: number; referenceId: string };
};

function normalizeSubscriptionStatus(value: unknown) {
  const status = asString(value);
  if (
    status === "trialing" ||
    status === "active" ||
    status === "past_due" ||
    status === "paused" ||
    status === "canceled"
  )
    return status;
  return "incomplete" as const;
}

function normalizeTransactionStatus(value: unknown) {
  const status = asString(value);
  if (status === "completed") return "paid" as const;
  if (
    status === "draft" ||
    status === "ready" ||
    status === "billed" ||
    status === "past_due" ||
    status === "canceled"
  )
    return status;
  return "failed" as const;
}

export function normalizePaddleWebhook(
  payload: unknown,
  graceDays = 7,
): NormalizedPaddleWebhook {
  const event = paddleEnvelopeSchema.parse(payload);
  const data = event.data;
  const custom = asRecord(data.custom_data);
  const organizationId =
    asString(custom.organization_id) ?? asString(custom.organizationId);
  const result: NormalizedPaddleWebhook = {
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: event.occurred_at,
    organizationId,
  };

  if (event.event_type.startsWith("subscription.")) {
    const subscriptionRef = asString(data.id);
    if (!subscriptionRef) throw new Error("paddle_subscription_id_missing");
    const scheduledChange = asRecord(data.scheduled_change);
    const status = normalizeSubscriptionStatus(data.status);
    const graceEndsAt =
      status === "past_due"
        ? new Date(event.occurred_at.getTime() + graceDays * 86_400_000)
        : null;
    const items = Array.isArray(data.items)
      ? data.items.flatMap((itemValue) => {
          const item = asRecord(itemValue);
          const price = asRecord(item.price);
          const providerPriceRef = asString(price.id);
          if (!providerPriceRef) return [];
          return [
            {
              providerPriceRef,
              providerItemRef: asString(item.id),
              quantity: Math.max(1, Number(item.quantity ?? 1)),
            },
          ];
        })
      : [];
    result.subscription = {
      customerRef: asString(data.customer_id),
      subscriptionRef,
      planCode: asString(custom.plan_code) ?? asString(custom.planCode),
      status,
      periodStart: asDate(
        data.current_billing_period &&
          asRecord(data.current_billing_period).starts_at,
      ),
      periodEnd: asDate(
        data.current_billing_period &&
          asRecord(data.current_billing_period).ends_at,
      ),
      graceEndsAt,
      cancelAtPeriodEnd:
        asString(scheduledChange.action) === "cancel" || status === "canceled",
      items,
    };
  }

  if (event.event_type.startsWith("transaction.")) {
    const transactionRef = asString(data.id);
    if (!transactionRef) throw new Error("paddle_transaction_id_missing");
    const details = asRecord(data.details);
    const totals = asRecord(details.totals);
    result.transaction = {
      transactionRef,
      status: normalizeTransactionStatus(data.status),
      currency: asString(data.currency_code) ?? "USD",
      subtotalMinor: asMinor(totals.subtotal),
      taxMinor: asMinor(totals.tax),
      totalMinor: asMinor(totals.total),
      invoiceNumber: asString(data.invoice_number),
      billedAt: asDate(data.billed_at),
    };
    const creditAmount = Number(
      custom.credit_amount ?? custom.creditAmount ?? 0,
    );
    if (
      event.event_type === "transaction.completed" &&
      Number.isSafeInteger(creditAmount) &&
      creditAmount > 0
    )
      result.creditPurchase = {
        entryKey: `paddle:${transactionRef}:credits`,
        amount: creditAmount,
        referenceId: transactionRef,
      };
  }
  return result;
}

export class PaddleBillingClient {
  private readonly baseUrl: string;

  constructor(private readonly config: PaddleConfig) {
    this.baseUrl =
      config.environment === "sandbox"
        ? "https://sandbox-api.paddle.com"
        : "https://api.paddle.com";
  }

  get clientToken() {
    return this.config.clientToken;
  }

  get environment() {
    return this.config.environment;
  }

  get webhookSecret() {
    return this.config.webhookSecret;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json()) as {
      data?: T;
      error?: { detail?: string; code?: string };
    };
    if (!response.ok || payload.data === undefined)
      throw new Error(
        payload.error?.code ?? payload.error?.detail ?? "paddle_request_failed",
      );
    return payload.data;
  }

  createCheckout(input: {
    providerPriceRef: string;
    quantity: number;
    organizationId: string;
    organizationName: string;
    ownerEmail?: string | null;
    planCode?: string | null;
    creditAmount?: number | null;
  }) {
    return this.request<Record<string, unknown>>("/transactions", {
      method: "POST",
      body: JSON.stringify({
        items: [{ price_id: input.providerPriceRef, quantity: input.quantity }],
        collection_mode: "automatic",
        checkout: { url: this.config.checkoutUrl },
        custom_data: {
          organization_id: input.organizationId,
          organization_name: input.organizationName,
          ...(input.planCode ? { plan_code: input.planCode } : {}),
          ...(input.creditAmount ? { credit_amount: input.creditAmount } : {}),
        },
      }),
    });
  }

  createPortalSession(input: {
    customerRef: string;
    subscriptionRef?: string | null;
  }) {
    return this.request<Record<string, unknown>>(
      `/customers/${encodeURIComponent(input.customerRef)}/portal-sessions`,
      {
        method: "POST",
        body: JSON.stringify(
          input.subscriptionRef
            ? { subscription_ids: [input.subscriptionRef] }
            : {},
        ),
      },
    );
  }
}
