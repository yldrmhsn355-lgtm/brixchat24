import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizePaddleWebhook, verifyPaddleSignature } from "./paddle";

describe("Paddle billing integration", () => {
  it("verifies the signed raw body and rejects stale signatures", () => {
    const rawBody = JSON.stringify({ event_id: "evt_1" });
    const secret = "pdl_ntfset_secret";
    const timestamp = 1_800_000_000;
    const hash = createHmac("sha256", secret)
      .update(`${timestamp}:${rawBody}`)
      .digest("hex");

    expect(
      verifyPaddleSignature({
        rawBody,
        secret,
        signature: `ts=${timestamp};h1=${hash}`,
        now: timestamp * 1000,
      }),
    ).toBe(true);
    expect(
      verifyPaddleSignature({
        rawBody: `${rawBody} `,
        secret,
        signature: `ts=${timestamp};h1=${hash}`,
        now: timestamp * 1000,
      }),
    ).toBe(false);
    expect(
      verifyPaddleSignature({
        rawBody,
        secret,
        signature: `ts=${timestamp};h1=${hash}`,
        now: (timestamp + 301) * 1000,
      }),
    ).toBe(false);
  });

  it("normalizes subscription state, tenant metadata, items, and grace", () => {
    const occurredAt = "2026-08-18T12:00:00.000Z";
    const result = normalizePaddleWebhook(
      {
        event_id: "evt_subscription",
        event_type: "subscription.past_due",
        occurred_at: occurredAt,
        data: {
          id: "sub_1",
          customer_id: "ctm_1",
          status: "past_due",
          custom_data: {
            organization_id: "00000000-0000-4000-8000-000000000001",
            plan_code: "professional",
          },
          current_billing_period: {
            starts_at: "2026-08-01T00:00:00.000Z",
            ends_at: "2026-09-01T00:00:00.000Z",
          },
          items: [{ id: "sbi_1", quantity: 2, price: { id: "pri_1" } }],
        },
      },
      7,
    );

    expect(result.organizationId).toBe("00000000-0000-4000-8000-000000000001");
    expect(result.subscription).toMatchObject({
      subscriptionRef: "sub_1",
      customerRef: "ctm_1",
      planCode: "professional",
      status: "past_due",
      items: [
        { providerItemRef: "sbi_1", providerPriceRef: "pri_1", quantity: 2 },
      ],
    });
    expect(result.subscription?.graceEndsAt?.toISOString()).toBe(
      "2026-08-25T12:00:00.000Z",
    );
  });

  it("credits the exact server-authored package metadata once completed", () => {
    const result = normalizePaddleWebhook({
      event_id: "evt_transaction",
      event_type: "transaction.completed",
      occurred_at: "2026-08-18T12:00:00.000Z",
      data: {
        id: "txn_1",
        status: "completed",
        currency_code: "USD",
        custom_data: {
          organization_id: "00000000-0000-4000-8000-000000000001",
          credit_amount: 2500,
        },
        details: { totals: { subtotal: "1000", tax: "200", total: "1200" } },
      },
    });

    expect(result.transaction).toMatchObject({
      transactionRef: "txn_1",
      status: "paid",
      subtotalMinor: 1000,
      taxMinor: 200,
      totalMinor: 1200,
    });
    expect(result.creditPurchase).toEqual({
      entryKey: "paddle:txn_1:credits",
      amount: 2500,
      referenceId: "txn_1",
    });
  });
});
