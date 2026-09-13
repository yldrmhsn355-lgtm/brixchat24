import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { TransactionSql } from "postgres";
import { withTenantScope } from "../tenant-scope";
import { DATABASE_ADVISORY_LOCK } from "../scoped-router";

type DatabaseClient = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

export type BillingSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "canceled"
  | "incomplete"
  | "legacy_free"
  | "manual";

export type BillingReconciliation = {
  organizationId: string;
  provider: string;
  eventId: string;
  eventType: string;
  occurredAt: Date;
  payloadHash: string;
  subscription?: {
    customerRef?: string | null;
    subscriptionRef: string;
    planCode?: string | null;
    status: BillingSubscriptionStatus;
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
  creditPurchase?: {
    entryKey: string;
    amount: number;
    referenceId: string;
  };
};

const metricAliases: Record<string, string> = {
  outgoing_messages: "monthly_outgoing_messages",
  ai_runs: "monthly_ai_runs",
  storage_bytes: "storage_bytes",
  channels: "channels",
  users: "users",
  automations: "automations",
};

const lineProductCodes = {
  whatsapp: "whatsapp_line",
  telegram: "telegram_line",
} as const;
export type BillingLineFamily = keyof typeof lineProductCodes;

export class BillingRepository {
  constructor(private readonly sql: DatabaseClient) {}

  private tenant<T>(
    organizationId: string,
    callback: (tx: TransactionSql) => Promise<T>,
  ): Promise<T> {
    return withTenantScope(
      this.sql,
      organizationId,
      callback as unknown as (tx: DatabaseClient) => Promise<T>,
    );
  }

  /**
   * Serializes concurrent storage-quota check-then-write critical sections
   * for one organization, closing the TOCTOU race where two uploads racing
   * the same plan limit both read the same pre-upload usage total (storage
   * usage is a live SUM over file_assets, not a locked counter row, so it
   * can't use the reserveUsage() pattern directly). Uses a session-level
   * advisory lock on a reserved connection: it blocks other sessions
   * requesting the same key regardless of which pooled connection they run
   * their queries on, so callers don't need to route the check and the
   * eventual file_assets insert through this same connection.
   */
  async acquireStorageLock(
    organizationId: string,
  ): Promise<{ release: () => Promise<void> }> {
    const scopedLock = Reflect.get(this.sql, DATABASE_ADVISORY_LOCK);
    if (typeof scopedLock === "function") return scopedLock(organizationId);
    const reserved = await this.sql.reserve();
    await reserved`SELECT pg_advisory_lock(hashtextextended(${organizationId},0))`;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await reserved`SELECT pg_advisory_unlock(hashtextextended(${organizationId},0))`;
        } finally {
          reserved.release();
        }
      },
    };
  }

  catalog(provider = "paddle") {
    return this.sql<Row[]>`
      SELECT product.id,product.code,product.name,product.product_type,
        product.plan_code,product.features,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id',price.id,'provider',price.provider,
          'providerPriceRef',price.provider_price_ref,
          'currency',price.currency,'interval',price.interval,
          'unitAmountMinor',price.unit_amount_minor,'creditsPerUnit',price.credits_per_unit,
          'taxMode',price.tax_mode
        ) ORDER BY price.interval) FILTER(WHERE price.id IS NOT NULL),'[]'::jsonb) prices
      FROM billing_products product
      LEFT JOIN billing_prices price ON price.product_id=product.id
        AND price.active=true AND price.provider=${provider}
      WHERE product.active=true
      GROUP BY product.id ORDER BY
        CASE product.product_type WHEN 'plan' THEN 0 WHEN 'channel' THEN 1
          WHEN 'seat' THEN 2 ELSE 3 END,product.name`;
  }

  overview(organizationId: string) {
    return this.tenant(organizationId, async (tx) => {
      const [
        subscriptions,
        entitlement,
        usage,
        accounts,
        transactions,
        ledger,
        lineCapacity,
        salesRequests,
      ] = await Promise.all([
        tx<Row[]>`
            SELECT subscription.id,subscription.provider,
              subscription.provider_customer_ref,subscription.provider_subscription_ref,
              subscription.plan_code,subscription.status,
              subscription.current_period_start,subscription.current_period_end,
              subscription.grace_ends_at,subscription.cancel_at_period_end,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id',item.id,'productCode',product.code,'productName',product.name,
                'productType',product.product_type,'quantity',item.quantity,
                'priceId',item.price_id
              )) FILTER(WHERE item.id IS NOT NULL),'[]'::jsonb) items
            FROM organization_subscriptions subscription
            LEFT JOIN subscription_items item ON item.subscription_id=subscription.id
              AND item.organization_id=subscription.organization_id
            LEFT JOIN billing_products product ON product.id=item.product_id
            WHERE subscription.organization_id=${organizationId}::uuid
            GROUP BY subscription.id ORDER BY subscription.updated_at DESC`,
        tx<Row[]>`
            SELECT plan.code,plan.display_name,plan.limits,entitlement.overrides,
              entitlement.trial_status,entitlement.trial_started_at,
              entitlement.trial_ends_at,entitlement.grace_ends_at
            FROM organization_entitlements entitlement
            JOIN plans plan ON plan.id=entitlement.plan_id
            WHERE entitlement.organization_id=${organizationId}::uuid`,
        tx<Row[]>`
            SELECT metric,quantity,period_start FROM usage_period_counters
            WHERE organization_id=${organizationId}::uuid
              AND period_start=date_trunc('month',current_date)::date
            ORDER BY metric`,
        tx<Row[]>`
            SELECT balance,total_purchased,total_used,auto_recharge_enabled,
              auto_recharge_threshold,auto_recharge_amount
            FROM credit_accounts WHERE organization_id=${organizationId}::uuid`,
        tx<Row[]>`
            SELECT id,provider,provider_transaction_ref,status,currency,
              subtotal_minor,tax_minor,total_minor,invoice_number,billed_at,created_at
            FROM billing_transactions
            WHERE organization_id=${organizationId}::uuid
            ORDER BY created_at DESC LIMIT 50`,
        tx<Row[]>`
            SELECT id,entry_type,amount,balance_after,reference_type,reference_id,created_at
            FROM credit_ledger_entries
            WHERE organization_id=${organizationId}::uuid
            ORDER BY created_at DESC LIMIT 50`,
        this.lineCapacityTx(tx, organizationId),
        tx<Row[]>`
            SELECT request.id,product.code product_code,product.name product_name,
              request.quantity,request.status,request.customer_note,
              request.review_note,request.reviewed_at,request.created_at
            FROM billing_sales_requests request
            JOIN billing_products product ON product.id=request.product_id
            WHERE request.organization_id=${organizationId}::uuid
            ORDER BY request.created_at DESC LIMIT 50`,
      ]);
      return {
        subscriptions,
        entitlement: entitlement[0] ?? null,
        usage,
        credits: accounts[0] ?? {
          balance: 0,
          total_purchased: 0,
          total_used: 0,
          auto_recharge_enabled: false,
          auto_recharge_threshold: 100,
          auto_recharge_amount: 1000,
        },
        transactions,
        creditLedger: ledger,
        lineCapacity,
        salesRequests,
      };
    });
  }

  private lineCapacityTx(tx: TransactionSql, organizationId: string) {
    return tx<Row[]>`
      WITH base AS (
        SELECT CASE
          WHEN COALESCE((entitlement.overrides->>'channels')::integer,
            (plan.limits->>'channels')::integer) IS NULL THEN NULL
          ELSE COALESCE((entitlement.overrides->>'channels')::integer,
            (plan.limits->>'channels')::integer,0)
        END included
        FROM organization_entitlements entitlement
        JOIN plans plan ON plan.id=entitlement.plan_id
        WHERE entitlement.organization_id=${organizationId}::uuid
      ), families(family,product_code) AS (
        VALUES ('whatsapp','whatsapp_line'),('telegram','telegram_line')
      )
      SELECT families.family,families.product_code,
        base.included,
        COALESCE((
          SELECT sum(item.quantity)::integer
          FROM subscription_items item
          JOIN organization_subscriptions subscription
            ON subscription.id=item.subscription_id
           AND subscription.organization_id=item.organization_id
          JOIN billing_products product ON product.id=item.product_id
          WHERE item.organization_id=${organizationId}::uuid
            AND product.code=families.product_code
            AND (
              subscription.status IN('active','trialing','legacy_free','manual')
              OR (subscription.status='past_due' AND subscription.grace_ends_at>=now())
              OR (subscription.status='canceled' AND subscription.current_period_end>=now())
            )
        ),0)::integer addon,
        COALESCE((
          SELECT sum(item.quantity)::integer
          FROM subscription_items item
          JOIN organization_subscriptions subscription
            ON subscription.id=item.subscription_id
           AND subscription.organization_id=item.organization_id
          JOIN billing_products product ON product.id=item.product_id
          WHERE item.organization_id=${organizationId}::uuid
            AND product.code=families.product_code
            AND subscription.provider='manual'
            AND subscription.status IN('active','trialing','legacy_free','manual')
        ),0)::integer manual_addon,
        CASE families.family
          WHEN 'whatsapp' THEN (SELECT count(*)::integer FROM channels
            WHERE organization_id=${organizationId}::uuid AND deleted_at IS NULL
              AND platform='whatsapp')
          WHEN 'telegram' THEN (SELECT count(*)::integer FROM channels
            WHERE organization_id=${organizationId}::uuid AND deleted_at IS NULL
              AND platform='telegram')
        END used
      FROM families CROSS JOIN base
      ORDER BY families.family`;
  }

  lineCapacity(organizationId: string) {
    return this.tenant(organizationId, (tx) =>
      this.lineCapacityTx(tx, organizationId),
    );
  }

  async policyForChannel(
    organizationId: string,
    family: BillingLineFamily,
  ): Promise<{
    allowed: boolean;
    code: string | null;
    limit: number | null;
    usage: number;
  }> {
    const subscriptionPolicy = await this.policy(organizationId, "channels");
    if (
      !subscriptionPolicy.allowed &&
      subscriptionPolicy.code !== "plan_limit_exceeded"
    )
      return subscriptionPolicy;
    const capacities = await this.lineCapacity(organizationId);
    const capacity = capacities.find((item) => item.family === family);
    if (!capacity) return subscriptionPolicy;
    const included =
      capacity.included == null ? null : Number(capacity.included);
    const addon = Number(capacity.addon ?? 0);
    const limit = included === null ? null : included + addon;
    const usage = Number(capacity.used ?? 0);
    const totalLimit =
      included === null
        ? null
        : included +
          capacities.reduce((sum, item) => sum + Number(item.addon ?? 0), 0);
    const totalUsage = capacities.reduce(
      (sum, item) => sum + Number(item.used ?? 0),
      0,
    );
    const allowed =
      (limit === null || usage < limit) &&
      (totalLimit === null || totalUsage < totalLimit);
    return {
      allowed,
      code: allowed ? null : "line_limit_exceeded",
      limit,
      usage,
    };
  }

  checkoutContext(organizationId: string, priceId: string) {
    return this.tenant(organizationId, async (tx) => {
      const [price] = await tx<Row[]>`
        SELECT price.id,price.provider,price.provider_price_ref,price.currency,
          price.interval,price.unit_amount_minor,price.credits_per_unit,
          product.code product_code,product.product_type,
          product.name product_name,product.product_type,product.plan_code
        FROM billing_prices price
        JOIN billing_products product ON product.id=price.product_id
        WHERE price.id=${priceId}::uuid AND price.active=true AND product.active=true`;
      if (!price || !price.provider_price_ref) return null;
      const [organization] = await tx<Row[]>`
        SELECT organization.id,organization.name,
          (SELECT users.email FROM organization_members member
           JOIN users ON users.id=member.user_id
           WHERE member.organization_id=organization.id AND member.role='owner'
           ORDER BY member.created_at LIMIT 1) owner_email
        FROM organizations organization WHERE organization.id=${organizationId}::uuid`;
      return organization ? { price, organization } : null;
    });
  }

  portalContext(organizationId: string, provider = "paddle") {
    return this.tenant(organizationId, async (tx) => {
      const [row] = await tx<Row[]>`
        SELECT provider_customer_ref,provider_subscription_ref
        FROM organization_subscriptions
        WHERE organization_id=${organizationId}::uuid AND provider=${provider}
          AND provider_customer_ref IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`;
      return row ?? null;
    });
  }

  reconcile(input: BillingReconciliation) {
    return this.tenant(input.organizationId, async (tx) => {
      const [claimed] = await tx<Array<{ id: string }>>`
        INSERT INTO billing_webhook_events(
          organization_id,provider,provider_event_id,event_type,payload_hash,
          occurred_at,status
        ) VALUES(
          ${input.organizationId}::uuid,${input.provider},${input.eventId},
          ${input.eventType},${input.payloadHash},${input.occurredAt},'processing'
        ) ON CONFLICT(provider,provider_event_id) DO UPDATE SET
          status='processing',event_type=excluded.event_type,
          payload_hash=excluded.payload_hash,occurred_at=excluded.occurred_at,
          error_code=NULL,processed_at=NULL
        WHERE billing_webhook_events.status='failed'
        RETURNING id`;
      if (!claimed) return { duplicate: true, applied: false };

      try {
        let subscriptionId: string | null = null;
        if (input.subscription) {
          const value = input.subscription;
          const [subscription] = await tx<Array<{ id: string }>>`
            INSERT INTO organization_subscriptions(
              organization_id,provider,provider_customer_ref,
              provider_subscription_ref,plan_code,status,current_period_start,
              current_period_end,grace_ends_at,cancel_at_period_end,
              last_provider_occurred_at
            ) VALUES(
              ${input.organizationId}::uuid,${input.provider},
              ${value.customerRef ?? null},${value.subscriptionRef},
              ${value.planCode ?? null},${value.status},${value.periodStart ?? null},
              ${value.periodEnd ?? null},${value.graceEndsAt ?? null},
              ${value.cancelAtPeriodEnd ?? false},${input.occurredAt}
            ) ON CONFLICT(organization_id,provider) DO UPDATE SET
              provider_customer_ref=COALESCE(excluded.provider_customer_ref,organization_subscriptions.provider_customer_ref),
              provider_subscription_ref=excluded.provider_subscription_ref,
              plan_code=COALESCE(excluded.plan_code,organization_subscriptions.plan_code),
              status=excluded.status,current_period_start=excluded.current_period_start,
              current_period_end=excluded.current_period_end,
              grace_ends_at=excluded.grace_ends_at,
              cancel_at_period_end=excluded.cancel_at_period_end,
              last_provider_occurred_at=excluded.last_provider_occurred_at,
              updated_at=now()
            WHERE organization_subscriptions.last_provider_occurred_at IS NULL
              OR excluded.last_provider_occurred_at>=organization_subscriptions.last_provider_occurred_at
            RETURNING id`;
          const subscriptionApplied = Boolean(subscription);
          subscriptionId = subscription?.id ?? null;
          if (!subscriptionId) {
            const [existing] = await tx<Array<{ id: string }>>`
              SELECT id FROM organization_subscriptions
              WHERE organization_id=${input.organizationId}::uuid
                AND provider=${input.provider}`;
            subscriptionId = existing?.id ?? null;
          }

          if (subscriptionApplied && subscriptionId && value.items) {
            await tx`
              DELETE FROM subscription_items
              WHERE organization_id=${input.organizationId}::uuid
                AND subscription_id=${subscriptionId}::uuid`;
            for (const item of value.items) {
              await tx`
                INSERT INTO subscription_items(
                  organization_id,subscription_id,product_id,price_id,
                  provider_item_ref,quantity
                )
                SELECT ${input.organizationId}::uuid,${subscriptionId}::uuid,
                  product.id,price.id,${item.providerItemRef ?? null},${item.quantity}
                FROM billing_prices price
                JOIN billing_products product ON product.id=price.product_id
                WHERE price.provider=${input.provider}
                  AND price.provider_price_ref=${item.providerPriceRef}
                ON CONFLICT(subscription_id,product_id) DO UPDATE SET
                  price_id=excluded.price_id,provider_item_ref=excluded.provider_item_ref,
                  quantity=excluded.quantity,updated_at=now()`;
            }
          }
          if (subscriptionApplied && value.planCode) {
            await tx`
              UPDATE organization_entitlements entitlement
              SET plan_id=plan.id,trial_status='inactive',trial_ends_at=NULL,
                grace_ends_at=${value.graceEndsAt ?? null},updated_at=now()
              FROM plans plan
              WHERE entitlement.organization_id=${input.organizationId}::uuid
                AND plan.code=${value.planCode}`;
          }
        }

        if (input.transaction) {
          const transaction = input.transaction;
          await tx`
            INSERT INTO billing_transactions(
              organization_id,subscription_id,provider,provider_transaction_ref,
              status,currency,subtotal_minor,tax_minor,total_minor,invoice_number,billed_at
              ,provider_occurred_at
            ) VALUES(
              ${input.organizationId}::uuid,${subscriptionId}::uuid,${input.provider},
              ${transaction.transactionRef},${transaction.status},
              ${transaction.currency.toUpperCase()},${transaction.subtotalMinor},
              ${transaction.taxMinor},${transaction.totalMinor},
              ${transaction.invoiceNumber ?? null},${transaction.billedAt ?? null},
              ${input.occurredAt}
            ) ON CONFLICT(provider,provider_transaction_ref) DO UPDATE SET
              subscription_id=COALESCE(excluded.subscription_id,billing_transactions.subscription_id),
              status=excluded.status,currency=excluded.currency,
              subtotal_minor=excluded.subtotal_minor,tax_minor=excluded.tax_minor,
              total_minor=excluded.total_minor,
              invoice_number=COALESCE(excluded.invoice_number,billing_transactions.invoice_number),
              billed_at=COALESCE(excluded.billed_at,billing_transactions.billed_at),
              provider_occurred_at=excluded.provider_occurred_at,updated_at=now()
            WHERE excluded.provider_occurred_at>=billing_transactions.provider_occurred_at`;
        }

        if (input.creditPurchase && input.creditPurchase.amount > 0)
          await this.adjustCreditsTx(tx, input.organizationId, {
            entryKey: input.creditPurchase.entryKey,
            entryType: "purchase",
            amount: input.creditPurchase.amount,
            referenceType: "billing_transaction",
            referenceId: input.creditPurchase.referenceId,
          });

        await tx`
          UPDATE billing_webhook_events SET status='processed',processed_at=now()
          WHERE id=${claimed.id}::uuid`;
        return { duplicate: false, applied: true };
      } catch (error) {
        await tx`
          UPDATE billing_webhook_events SET status='failed',processed_at=now(),
            error_code=${error instanceof Error ? error.message.slice(0, 120) : "reconcile_failed"}
          WHERE id=${claimed.id}::uuid`;
        throw error;
      }
    });
  }

  async policy(
    organizationId: string,
    metric: string,
  ): Promise<{
    allowed: boolean;
    code: string | null;
    limit: number | null;
    usage: number;
  }> {
    if (metric === "channels:whatsapp" || metric === "channels:telegram")
      return this.policyForChannel(
        organizationId,
        metric.slice("channels:".length) as BillingLineFamily,
      );
    return this.tenant(organizationId, async (tx) => {
      const [row] = await tx<Row[]>`
        SELECT organization.operational_status,entitlement.trial_status,
          entitlement.trial_ends_at,entitlement.grace_ends_at trial_grace_ends_at,
          entitlement.overrides,plan.limits,
          subscription.status subscription_status,
          subscription.current_period_end,subscription.grace_ends_at billing_grace_ends_at,
          COALESCE(counter.quantity,
            CASE
              WHEN ${metric}='channels' THEN (
                SELECT count(*) FROM channels channel
                WHERE channel.organization_id=organization.id
                  AND channel.deleted_at IS NULL
              )
              WHEN ${metric}='users' THEN (
                SELECT count(*) FROM organization_members member
                WHERE member.organization_id=organization.id
              )
              WHEN ${metric}='automations' THEN (
                SELECT count(*) FROM automation_rules automation
                WHERE automation.organization_id=organization.id
                  AND automation.status<>'archived'
              )
              WHEN ${metric}='storage_bytes' THEN (
                SELECT COALESCE(sum(asset.size_bytes),0) FROM file_assets asset
                WHERE asset.organization_id=organization.id
                  AND asset.deleted_at IS NULL
              ) + (
                SELECT COALESCE(sum(qra.size_bytes),0)
                FROM quick_reply_attachments qra
                WHERE qra.organization_id=organization.id
              )
              ELSE 0
            END,0)::bigint usage,
          COALESCE(limit_override.hard_limit,
            (entitlement.overrides->>${metric})::bigint,
            (plan.limits->>${metric})::bigint,
            (plan.limits->>${metricAliases[metric] ?? metric})::bigint) hard_limit
        FROM organizations organization
        LEFT JOIN organization_entitlements entitlement
          ON entitlement.organization_id=organization.id
        LEFT JOIN plans plan ON plan.id=entitlement.plan_id
        LEFT JOIN organization_subscriptions subscription
          ON subscription.organization_id=organization.id
          AND subscription.provider IN('paddle','manual')
        LEFT JOIN organization_usage_limits limit_override
          ON limit_override.organization_id=organization.id
          AND limit_override.metric=${metric}
        LEFT JOIN usage_period_counters counter
          ON counter.organization_id=organization.id AND counter.metric=${metric}
          AND counter.period_start=date_trunc('month',current_date)::date
        WHERE organization.id=${organizationId}::uuid
        ORDER BY CASE subscription.provider WHEN 'paddle' THEN 0 ELSE 1 END
        LIMIT 1`;
      if (!row || row.operational_status !== "active")
        return {
          allowed: false,
          code: "organization_disabled",
          limit: null,
          usage: 0,
        };

      const now = Date.now();
      const subscriptionStatus = String(row.subscription_status ?? "");
      const periodEnd = row.current_period_end
        ? new Date(String(row.current_period_end)).getTime()
        : null;
      const billingGraceEnd = row.billing_grace_ends_at
        ? new Date(String(row.billing_grace_ends_at)).getTime()
        : null;
      const subscriptionAllowed =
        !subscriptionStatus ||
        ["active", "trialing", "legacy_free", "manual"].includes(
          subscriptionStatus,
        ) ||
        (subscriptionStatus === "past_due" &&
          billingGraceEnd !== null &&
          billingGraceEnd >= now) ||
        (subscriptionStatus === "canceled" &&
          periodEnd !== null &&
          periodEnd >= now);
      if (!subscriptionAllowed)
        return {
          allowed: false,
          code: "payment_required",
          limit: null,
          usage: Number(row.usage ?? 0),
        };

      const trialStatus = String(row.trial_status ?? "inactive");
      const trialEnd = row.trial_ends_at
        ? new Date(String(row.trial_ends_at)).getTime()
        : null;
      const trialGraceEnd = row.trial_grace_ends_at
        ? new Date(String(row.trial_grace_ends_at)).getTime()
        : null;
      if (
        trialStatus === "expired" ||
        (trialStatus === "active" && trialEnd !== null && trialEnd < now) ||
        (trialStatus === "grace" &&
          trialGraceEnd !== null &&
          trialGraceEnd < now)
      )
        return {
          allowed: false,
          code: "trial_expired",
          limit: null,
          usage: Number(row.usage ?? 0),
        };

      const limit = row.hard_limit == null ? null : Number(row.hard_limit);
      const usage = Number(row.usage ?? 0);
      return {
        allowed: limit === null || usage < limit,
        code: limit !== null && usage >= limit ? "plan_limit_exceeded" : null,
        limit,
        usage,
      };
    });
  }

  async policyForInvitation(tokenHash: string, metric: string) {
    const [invitation] = await this.sql<Array<{ organization_id: string }>>`
      SELECT organization_id FROM organization_invitations
      WHERE token_hash=${tokenHash} AND accepted_at IS NULL
        AND revoked_at IS NULL AND expires_at>now()`;
    return invitation
      ? this.policy(invitation.organization_id, metric)
      : { allowed: true, code: null, limit: null, usage: 0 };
  }

  reserveUsage(input: {
    organizationId: string;
    eventKey: string;
    metric: string;
    quantity?: number;
  }) {
    const quantity = input.quantity ?? 1;
    return this.tenant(input.organizationId, async (tx) => {
      const [existing] = await tx<Array<{ id: string }>>`
        SELECT id FROM usage_events
        WHERE organization_id=${input.organizationId}::uuid
          AND event_key=${input.eventKey}`;
      if (existing)
        return {
          allowed: true,
          code: null,
          limit: null,
          usage: 0,
          duplicate: true,
        };
      const policy = await this.policyTx(
        tx,
        input.organizationId,
        input.metric,
      );
      if (!policy.allowed) return policy;
      await tx`
        INSERT INTO usage_period_counters(organization_id,metric,period_start,quantity)
        VALUES(${input.organizationId}::uuid,${input.metric},
          date_trunc('month',current_date)::date,0)
        ON CONFLICT DO NOTHING`;
      const [counter] = await tx<Array<{ quantity: number }>>`
        SELECT quantity FROM usage_period_counters
        WHERE organization_id=${input.organizationId}::uuid
          AND metric=${input.metric}
          AND period_start=date_trunc('month',current_date)::date
        FOR UPDATE`;
      const next = Number(counter?.quantity ?? 0) + quantity;
      if (policy.limit !== null && next > policy.limit)
        return {
          ...policy,
          allowed: false,
          code: "plan_limit_exceeded",
          duplicate: false,
        };
      const [inserted] = await tx<Array<{ id: string }>>`
        INSERT INTO usage_events(organization_id,event_key,metric,quantity)
        VALUES(${input.organizationId}::uuid,${input.eventKey},${input.metric},${quantity})
        ON CONFLICT(organization_id,event_key) DO NOTHING
        RETURNING id`;
      if (!inserted) {
        // A concurrent call already recorded this event_key between our
        // pre-check above and this insert (e.g. a client retry racing the
        // original request). Treat it as the idempotent duplicate it is
        // instead of surfacing the unique-constraint violation.
        return {
          ...policy,
          usage: Number(counter?.quantity ?? 0),
          duplicate: true,
        };
      }
      await tx`
        UPDATE usage_period_counters SET quantity=${next},updated_at=now()
        WHERE organization_id=${input.organizationId}::uuid
          AND metric=${input.metric}
          AND period_start=date_trunc('month',current_date)::date`;
      await tx`
        INSERT INTO usage_daily_rollups(organization_id,usage_date,metric,quantity)
        VALUES(${input.organizationId}::uuid,current_date,${input.metric},${quantity})
        ON CONFLICT(organization_id,usage_date,metric) DO UPDATE SET
          quantity=usage_daily_rollups.quantity+excluded.quantity,updated_at=now()`;
      return { ...policy, usage: next, duplicate: false };
    });
  }

  /**
   * Reverses a prior reserveUsage() reservation when the operation it was
   * gating (e.g. sending a message) ultimately failed after the quota was
   * already committed. No-ops if the event was never reserved or was already
   * released, so it's safe to call from a catch block without checking state
   * first.
   */
  releaseUsage(input: { organizationId: string; eventKey: string }) {
    return this.tenant(input.organizationId, async (tx) => {
      const [deleted] = await tx<Array<{ metric: string; quantity: number }>>`
        DELETE FROM usage_events
        WHERE organization_id=${input.organizationId}::uuid
          AND event_key=${input.eventKey}
        RETURNING metric,quantity`;
      if (!deleted) return { released: false };
      await tx`
        INSERT INTO usage_period_counters(organization_id,metric,period_start,quantity)
        VALUES(${input.organizationId}::uuid,${deleted.metric},
          date_trunc('month',current_date)::date,0)
        ON CONFLICT DO NOTHING`;
      await tx`
        SELECT quantity FROM usage_period_counters
        WHERE organization_id=${input.organizationId}::uuid
          AND metric=${deleted.metric}
          AND period_start=date_trunc('month',current_date)::date
        FOR UPDATE`;
      await tx`
        UPDATE usage_period_counters
        SET quantity=GREATEST(quantity-${deleted.quantity},0),updated_at=now()
        WHERE organization_id=${input.organizationId}::uuid
          AND metric=${deleted.metric}
          AND period_start=date_trunc('month',current_date)::date`;
      await tx`
        UPDATE usage_daily_rollups
        SET quantity=GREATEST(quantity-${deleted.quantity},0),updated_at=now()
        WHERE organization_id=${input.organizationId}::uuid
          AND usage_date=current_date
          AND metric=${deleted.metric}`;
      return { released: true };
    });
  }

  private async policyTx(
    tx: TransactionSql,
    organizationId: string,
    metric: string,
  ) {
    const [row] = await tx<Row[]>`
      SELECT organization.operational_status,entitlement.trial_status,
        entitlement.trial_ends_at,entitlement.grace_ends_at trial_grace_ends_at,
        subscription.status subscription_status,subscription.current_period_end,
        subscription.grace_ends_at billing_grace_ends_at,
        COALESCE(limit_override.hard_limit,
          (entitlement.overrides->>${metric})::bigint,
          (plan.limits->>${metric})::bigint,
          (plan.limits->>${metricAliases[metric] ?? metric})::bigint) hard_limit
      FROM organizations organization
      LEFT JOIN organization_entitlements entitlement ON entitlement.organization_id=organization.id
      LEFT JOIN plans plan ON plan.id=entitlement.plan_id
      LEFT JOIN organization_subscriptions subscription ON subscription.organization_id=organization.id
        AND subscription.provider IN('paddle','manual')
      LEFT JOIN organization_usage_limits limit_override
        ON limit_override.organization_id=organization.id AND limit_override.metric=${metric}
      WHERE organization.id=${organizationId}::uuid
      ORDER BY CASE subscription.provider WHEN 'paddle' THEN 0 ELSE 1 END LIMIT 1`;
    if (!row || row.operational_status !== "active")
      return {
        allowed: false,
        code: "organization_disabled",
        limit: null,
        usage: 0,
      };
    const now = Date.now();
    const status = String(row.subscription_status ?? "");
    const periodEnd = row.current_period_end
      ? new Date(String(row.current_period_end)).getTime()
      : null;
    const graceEnd = row.billing_grace_ends_at
      ? new Date(String(row.billing_grace_ends_at)).getTime()
      : null;
    if (
      status &&
      !["active", "trialing", "legacy_free", "manual"].includes(status) &&
      !(status === "past_due" && graceEnd !== null && graceEnd >= now) &&
      !(status === "canceled" && periodEnd !== null && periodEnd >= now)
    )
      return {
        allowed: false,
        code: "payment_required",
        limit: null,
        usage: 0,
      };
    const trialStatus = String(row.trial_status ?? "inactive");
    const trialEnd = row.trial_ends_at
      ? new Date(String(row.trial_ends_at)).getTime()
      : null;
    const trialGrace = row.trial_grace_ends_at
      ? new Date(String(row.trial_grace_ends_at)).getTime()
      : null;
    if (
      trialStatus === "expired" ||
      (trialStatus === "active" && trialEnd !== null && trialEnd < now) ||
      (trialStatus === "grace" && trialGrace !== null && trialGrace < now)
    )
      return { allowed: false, code: "trial_expired", limit: null, usage: 0 };
    return {
      allowed: true,
      code: null,
      limit: row.hard_limit == null ? null : Number(row.hard_limit),
      usage: 0,
    };
  }

  updateAutoRecharge(
    organizationId: string,
    input: { enabled: boolean; threshold: number; amount: number },
  ) {
    return this.tenant(organizationId, async (tx) => {
      const [account] = await tx<Row[]>`
        INSERT INTO credit_accounts(
          organization_id,auto_recharge_enabled,auto_recharge_threshold,
          auto_recharge_amount
        ) VALUES(${organizationId}::uuid,${input.enabled},${input.threshold},${input.amount})
        ON CONFLICT(organization_id) DO UPDATE SET
          auto_recharge_enabled=excluded.auto_recharge_enabled,
          auto_recharge_threshold=excluded.auto_recharge_threshold,
          auto_recharge_amount=excluded.auto_recharge_amount,updated_at=now()
        RETURNING balance,total_purchased,total_used,auto_recharge_enabled,
          auto_recharge_threshold,auto_recharge_amount`;
      return account!;
    });
  }

  adjustCredits(
    organizationId: string,
    input: {
      entryKey: string;
      entryType: "purchase" | "usage" | "refund" | "adjustment";
      amount: number;
      referenceType?: string;
      referenceId?: string;
    },
  ) {
    return this.tenant(organizationId, (tx) =>
      this.adjustCreditsTx(tx, organizationId, input),
    );
  }

  private async adjustCreditsTx(
    tx: TransactionSql,
    organizationId: string,
    input: {
      entryKey: string;
      entryType: "purchase" | "usage" | "refund" | "adjustment";
      amount: number;
      referenceType?: string;
      referenceId?: string;
    },
  ) {
    const [duplicate] = await tx<Row[]>`
      SELECT balance_after FROM credit_ledger_entries
      WHERE organization_id=${organizationId}::uuid AND entry_key=${input.entryKey}`;
    if (duplicate)
      return { duplicate: true, balance: Number(duplicate.balance_after) };
    await tx`INSERT INTO credit_accounts(organization_id) VALUES(${organizationId}::uuid) ON CONFLICT DO NOTHING`;
    const [account] = await tx<Array<{ balance: number }>>`
      SELECT balance FROM credit_accounts
      WHERE organization_id=${organizationId}::uuid FOR UPDATE`;
    const next = Number(account?.balance ?? 0) + input.amount;
    if (next < 0) throw new Error("insufficient_credits");
    await tx`
      UPDATE credit_accounts SET balance=${next},
        total_purchased=total_purchased+CASE WHEN ${input.amount}>0 AND ${input.entryType}='purchase' THEN ${input.amount} ELSE 0 END,
        total_used=total_used+CASE WHEN ${input.amount}<0 AND ${input.entryType}='usage' THEN ${Math.abs(input.amount)} ELSE 0 END,
        updated_at=now()
      WHERE organization_id=${organizationId}::uuid`;
    await tx`
      INSERT INTO credit_ledger_entries(
        organization_id,entry_key,entry_type,amount,balance_after,
        reference_type,reference_id
      ) VALUES(${organizationId}::uuid,${input.entryKey},${input.entryType},
        ${input.amount},${next},${input.referenceType ?? null},${input.referenceId ?? null})`;
    return { duplicate: false, balance: next };
  }

  listPrices() {
    return this.sql<Row[]>`
      SELECT price.id,product.code product_code,product.name product_name,
        product.product_type,price.provider,price.provider_price_ref,
        price.currency,price.interval,price.unit_amount_minor,price.credits_per_unit,
        price.tax_mode,
        price.active
      FROM billing_products product
      LEFT JOIN billing_prices price ON price.product_id=product.id
      ORDER BY product.name,price.provider,price.interval`;
  }

  upsertPrice(input: {
    productCode: string;
    provider: string;
    providerPriceRef?: string | null;
    currency: string;
    interval: "month" | "year" | "one_time";
    unitAmountMinor: number;
    creditsPerUnit?: number | null;
    taxMode: "provider" | "inclusive" | "exclusive";
    active: boolean;
  }) {
    return this.sql<Row[]>`
      INSERT INTO billing_prices(
        product_id,provider,provider_price_ref,currency,interval,
        unit_amount_minor,credits_per_unit,tax_mode,active
      ) SELECT product.id,${input.provider},${input.providerPriceRef ?? null},
        ${input.currency.toUpperCase()},${input.interval},${input.unitAmountMinor},
        ${input.creditsPerUnit ?? null},${input.taxMode},${input.active}
      FROM billing_products product WHERE product.code=${input.productCode}
      ON CONFLICT(product_id,provider,currency,interval) DO UPDATE SET
        provider_price_ref=excluded.provider_price_ref,
        unit_amount_minor=excluded.unit_amount_minor,
        credits_per_unit=excluded.credits_per_unit,tax_mode=excluded.tax_mode,
        active=excluded.active,updated_at=now()
      RETURNING id`;
  }

  setManualSubscription(input: {
    organizationId: string;
    planCode: string;
    status: "manual" | "legacy_free" | "active" | "past_due" | "canceled";
    periodEnd?: Date | null;
    graceEndsAt?: Date | null;
    lineItems?: Array<{
      productCode: "whatsapp_line" | "telegram_line";
      quantity: number;
    }>;
    actorId: string;
  }) {
    return this.tenant(input.organizationId, async (tx) => {
      const [row] = await tx<Row[]>`
        INSERT INTO organization_subscriptions(
          organization_id,provider,plan_code,status,current_period_end,grace_ends_at
        ) SELECT ${input.organizationId}::uuid,'manual',plan.code,${input.status},
          ${input.periodEnd ?? null},${input.graceEndsAt ?? null}
        FROM plans plan WHERE plan.code=${input.planCode}
        ON CONFLICT(organization_id,provider) DO UPDATE SET
          plan_code=excluded.plan_code,status=excluded.status,
          current_period_end=excluded.current_period_end,
          grace_ends_at=excluded.grace_ends_at,updated_at=now()
        RETURNING id`;
      if (!row) return false;
      if (input.lineItems) {
        for (const item of input.lineItems) {
          if (item.quantity <= 0) {
            await tx`
              DELETE FROM subscription_items subscription_item
              USING billing_products product
              WHERE subscription_item.organization_id=${input.organizationId}::uuid
                AND subscription_item.subscription_id=${String(row.id)}::uuid
                AND subscription_item.product_id=product.id
                AND product.code=${item.productCode}`;
          } else {
            await tx`
              INSERT INTO subscription_items(
                organization_id,subscription_id,product_id,quantity
              ) SELECT ${input.organizationId}::uuid,${String(row.id)}::uuid,
                product.id,${item.quantity}
              FROM billing_products product
              WHERE product.code=${item.productCode} AND product.product_type='channel'
              ON CONFLICT(subscription_id,product_id) DO UPDATE SET
                quantity=excluded.quantity,updated_at=now()`;
          }
        }
      }
      await tx`
        UPDATE organization_entitlements entitlement SET plan_id=plan.id,updated_at=now()
        FROM plans plan WHERE entitlement.organization_id=${input.organizationId}::uuid
          AND plan.code=${input.planCode}`;
      await tx`
        INSERT INTO tenant_provisioning_audit(organization_id,action,actor,details)
        VALUES(${input.organizationId}::uuid,'set_subscription',${input.actorId},
          ${tx.json({ planCode: input.planCode, status: input.status, lineItems: input.lineItems ?? null, source: "platform_admin_panel" } as never)})`;
      return true;
    });
  }

  createLineSalesRequest(input: {
    organizationId: string;
    productCode: "whatsapp_line" | "telegram_line";
    quantity: number;
    customerNote?: string | null;
    requestedBy: string;
  }) {
    return this.tenant(input.organizationId, async (tx) => {
      const [row] = await tx<Row[]>`
        INSERT INTO billing_sales_requests(
          organization_id,product_id,quantity,customer_note,requested_by
        ) SELECT ${input.organizationId}::uuid,product.id,${input.quantity},
          ${input.customerNote ?? null},${input.requestedBy}::uuid
        FROM billing_products product
        WHERE product.code=${input.productCode} AND product.product_type='channel'
          AND product.active=true
        ON CONFLICT(organization_id,product_id) WHERE status='pending'
        DO UPDATE SET quantity=excluded.quantity,customer_note=excluded.customer_note,
          requested_by=excluded.requested_by,updated_at=now()
        RETURNING id,status,quantity,created_at,updated_at`;
      return row ?? null;
    });
  }

  reviewLineSalesRequest(input: {
    organizationId: string;
    requestId: string;
    decision: "approved" | "rejected";
    reviewNote?: string | null;
    actorId: string;
  }) {
    return this.tenant(input.organizationId, async (tx) => {
      const [request] = await tx<Row[]>`
        SELECT request.id,request.organization_id,request.quantity,
          product.code product_code
        FROM billing_sales_requests request
        JOIN billing_products product ON product.id=request.product_id
        WHERE request.id=${input.requestId}::uuid
          AND request.organization_id=${input.organizationId}::uuid
          AND request.status='pending'
        FOR UPDATE`;
      if (!request) return null;
      if (input.decision === "approved") {
        const [subscription] = await tx<Row[]>`
          INSERT INTO organization_subscriptions(
            organization_id,provider,plan_code,status
          ) SELECT ${String(request.organization_id)}::uuid,'manual',plan.code,'manual'
          FROM organization_entitlements entitlement
          JOIN plans plan ON plan.id=entitlement.plan_id
          WHERE entitlement.organization_id=${String(request.organization_id)}::uuid
          ON CONFLICT(organization_id,provider) DO UPDATE SET
            status=CASE
              WHEN organization_subscriptions.status='legacy_free' THEN 'manual'
              ELSE organization_subscriptions.status
            END,updated_at=now()
          RETURNING id`;
        if (!subscription)
          throw new Error("line_activation_subscription_missing");
        await tx`
          INSERT INTO subscription_items(
            organization_id,subscription_id,product_id,quantity
          ) SELECT ${String(request.organization_id)}::uuid,${String(subscription.id)}::uuid,
            product.id,${Number(request.quantity)}
          FROM billing_products product WHERE product.code=${String(request.product_code)}
          ON CONFLICT(subscription_id,product_id) DO UPDATE SET
            quantity=subscription_items.quantity+excluded.quantity,updated_at=now()`;
      }
      const [updated] = await tx<Row[]>`
        UPDATE billing_sales_requests SET status=${input.decision},
          review_note=${input.reviewNote ?? null},reviewed_by=${input.actorId}::uuid,
          reviewed_at=now(),updated_at=now()
        WHERE id=${input.requestId}::uuid
        RETURNING id,organization_id,status,quantity,reviewed_at`;
      await tx`
        INSERT INTO tenant_provisioning_audit(organization_id,action,actor,details)
        VALUES(${String(request.organization_id)}::uuid,'review_line_sale',${input.actorId},
          ${tx.json({ requestId: input.requestId, productCode: request.product_code, quantity: request.quantity, decision: input.decision, source: "platform_admin_panel" } as never)})`;
      return updated ?? null;
    });
  }

  static payloadHash(rawBody: string) {
    return createHash("sha256").update(rawBody).digest("hex");
  }
}
