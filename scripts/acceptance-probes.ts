import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createDatabase } from "../packages/database/src/index";
import {
  Bitrix24Provider,
  BitrixRestClient,
  createMalwareScanner,
  createObjectStorageProvider,
  decryptSecret,
  MetaWhatsAppCloudProvider,
} from "../packages/integrations/src/index";
import { SmtpEmailProvider } from "../apps/api/src/email";
import {
  hashEvidence,
  type AcceptanceService,
  type SafeEvidenceValue,
} from "./acceptance-report";

export class MissingAcceptanceConfigurationError extends Error {
  readonly code = "ACCEPTANCE_CONFIGURATION_MISSING";

  constructor(readonly missing: string[]) {
    super("External acceptance configuration is incomplete");
  }
}

export class AcceptanceConfirmationRequiredError extends Error {
  readonly code = "ACCEPTANCE_CONFIRMATION_REQUIRED";

  constructor(readonly confirmation: string) {
    super("External acceptance mutation requires explicit confirmation");
  }
}

export interface AcceptanceProbeResult {
  evidence: Record<string, SafeEvidenceValue>;
  privateState?: Record<string, string>;
}

const requireEnv = <const Names extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  names: Names,
): { [Name in Names[number]]: string } => {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) throw new MissingAcceptanceConfigurationError(missing);
  return Object.fromEntries(
    names.map((name) => [name, env[name] as string]),
  ) as { [Name in Names[number]]: string };
};

const requireConfirmation = (
  env: NodeJS.ProcessEnv,
  name: string,
  expected: string,
) => {
  if (env[name] !== expected)
    throw new AcceptanceConfirmationRequiredError(`${name}=${expected}`);
};

const metaProvider = (env: NodeJS.ProcessEnv) =>
  new MetaWhatsAppCloudProvider(
    env.META_WHATSAPP_API_VERSION ?? "v25.0",
    Number(env.EXTERNAL_ACCEPTANCE_TIMEOUT_MS ?? 15_000),
  );

type MetaAcceptanceCredentials = {
  accessToken: string;
  phoneNumberId: string;
  source: "environment" | "encrypted-database";
};

type BitrixAcceptanceCredentials = {
  webhookUrl?: string;
  portalUrl?: string;
  accessToken?: string;
  source: "environment" | "encrypted-database";
};

export function selectAcceptanceRow<Row extends { public_id: string }>(
  rows: Row[],
  selector: string | undefined,
  selectorName: string,
): Row {
  const selected = selector
    ? rows.filter((row) => row.public_id === selector)
    : rows;
  if (selected.length !== 1)
    throw new MissingAcceptanceConfigurationError([
      selected.length === 0
        ? `${selectorName} (no matching connected record)`
        : `${selectorName} (required when multiple connected records exist)`,
    ]);
  return selected[0]!;
}

async function withAcceptanceDatabase<Result>(
  env: NodeJS.ProcessEnv,
  query: (client: AcceptanceQuery) => Promise<Result>,
): Promise<Result> {
  const databaseUrl = requireEnv(env, ["DATABASE_URL"]).DATABASE_URL;
  const { client } = createDatabase(databaseUrl);
  try {
    return await query(client as unknown as AcceptanceQuery);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function resolveMetaCredentials(
  env: NodeJS.ProcessEnv,
): Promise<MetaAcceptanceCredentials> {
  const accessToken = env.META_WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.META_WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (accessToken || phoneNumberId) {
    const values = requireEnv(env, [
      "META_WHATSAPP_ACCESS_TOKEN",
      "META_WHATSAPP_PHONE_NUMBER_ID",
    ]);
    return {
      accessToken: values.META_WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: values.META_WHATSAPP_PHONE_NUMBER_ID,
      source: "environment",
    };
  }

  const encryptionKey = requireEnv(env, [
    "APP_ENCRYPTION_KEY",
  ]).APP_ENCRYPTION_KEY;
  return withAcceptanceDatabase(env, async (client) => {
    const rows = (await client`
      SELECT public_id::text,phone_number_id,credentials_encrypted
      FROM channels
      WHERE provider='meta'
        AND status='connected'
        AND deleted_at IS NULL
        AND phone_number_id IS NOT NULL
        AND credentials_encrypted IS NOT NULL
      ORDER BY created_at
    `) as Array<{
      public_id: string;
      phone_number_id: string;
      credentials_encrypted: string;
    }>;
    const row = selectAcceptanceRow(
      rows,
      env.META_ACCEPTANCE_CHANNEL_PUBLIC_ID?.trim(),
      "META_ACCEPTANCE_CHANNEL_PUBLIC_ID",
    );
    let decrypted: { accessToken?: unknown };
    try {
      decrypted = JSON.parse(
        decryptSecret(row.credentials_encrypted, encryptionKey),
      ) as { accessToken?: unknown };
    } catch {
      throw new MissingAcceptanceConfigurationError([
        "decryptable Meta channel credentials",
      ]);
    }
    if (typeof decrypted.accessToken !== "string" || !decrypted.accessToken)
      throw new MissingAcceptanceConfigurationError([
        "Meta channel access token",
      ]);
    return {
      accessToken: decrypted.accessToken,
      phoneNumberId: row.phone_number_id,
      source: "encrypted-database",
    };
  });
}

async function runMetaProbe(
  scenario: string,
  env: NodeJS.ProcessEnv,
  correlationId: string,
): Promise<AcceptanceProbeResult> {
  const values = await resolveMetaCredentials(env);
  const provider = metaProvider(env);
  if (scenario === "verify") {
    const result = await provider.healthCheck({
      accessToken: values.accessToken,
      phoneNumberId: values.phoneNumberId,
      ...(env.META_ACCEPTANCE_EXPECTED_CALLBACK_URI
        ? {
            expectedWebhookCallbackUri:
              env.META_ACCEPTANCE_EXPECTED_CALLBACK_URI,
          }
        : {}),
    });
    if (!result.healthy || result.status !== "healthy")
      throw Object.assign(new Error("Meta health check did not pass"), {
        code: result.code ?? "META_HEALTH_NOT_READY",
      });
    return {
      evidence: {
        provider: "meta",
        credentialSource: values.source,
        apiVersion: env.META_WHATSAPP_API_VERSION ?? "v25.0",
        healthStatus: result.status,
        webhookRouteVerified:
          result.profile?.webhookRouteMatches === "true" ||
          !env.META_ACCEPTANCE_EXPECTED_CALLBACK_URI,
      },
    };
  }
  const recipient = requireEnv(env, [
    "META_ACCEPTANCE_TEST_PHONE",
  ]).META_ACCEPTANCE_TEST_PHONE;
  requireConfirmation(env, "META_ACCEPTANCE_CONFIRM", "SEND");
  if (scenario === "send-text") {
    const marker = `Brixchat24 acceptance ${correlationId}`;
    const result = await provider.sendMessage({
      channelId: "external-acceptance",
      phoneNumberId: values.phoneNumberId,
      recipient,
      text: marker,
      idempotencyKey: correlationId,
      accessToken: values.accessToken,
    });
    return {
      evidence: {
        providerAccepted: true,
        providerMessageIdHash: hashEvidence(result.providerMessageId),
        recipientHash: hashEvidence(recipient),
        markerHash: hashEvidence(marker),
      },
      privateState: {
        providerMessageId: result.providerMessageId,
        outboundMarker: marker,
      },
    };
  }
  if (scenario === "send-template") {
    const template = requireEnv(env, [
      "META_ACCEPTANCE_TEMPLATE_NAME",
    ]).META_ACCEPTANCE_TEMPLATE_NAME;
    const result = await provider.sendTemplate({
      channelId: "external-acceptance",
      phoneNumberId: values.phoneNumberId,
      recipient,
      templateName: template,
      language: env.META_ACCEPTANCE_TEMPLATE_LANGUAGE ?? "tr",
      variables: (env.META_ACCEPTANCE_TEMPLATE_VARIABLES ?? "")
        .split("|")
        .filter(Boolean),
      idempotencyKey: correlationId,
      accessToken: values.accessToken,
    });
    return {
      evidence: {
        providerAccepted: true,
        providerMessageIdHash: hashEvidence(result.providerMessageId),
        recipientHash: hashEvidence(recipient),
        templateHash: hashEvidence(template),
      },
      privateState: { providerMessageId: result.providerMessageId },
    };
  }
  if (scenario === "send-media") {
    const media = requireEnv(env, [
      "META_ACCEPTANCE_MEDIA_URL",
    ]).META_ACCEPTANCE_MEDIA_URL;
    const mediaType = env.META_ACCEPTANCE_MEDIA_TYPE ?? "image";
    if (!["image", "video", "audio", "document"].includes(mediaType))
      throw Object.assign(new Error("Unsupported acceptance media type"), {
        code: "META_ACCEPTANCE_MEDIA_TYPE_INVALID",
      });
    const result = await provider.sendMedia({
      channelId: "external-acceptance",
      phoneNumberId: values.phoneNumberId,
      recipient,
      mediaType: mediaType as "image" | "video" | "audio" | "document",
      link: media,
      idempotencyKey: correlationId,
      accessToken: values.accessToken,
    });
    return {
      evidence: {
        providerAccepted: true,
        providerMessageIdHash: hashEvidence(result.providerMessageId),
        recipientHash: hashEvidence(recipient),
        mediaType,
      },
      privateState: { providerMessageId: result.providerMessageId },
    };
  }
  throw Object.assign(new Error("Unsupported Meta scenario"), {
    code: "ACCEPTANCE_SCENARIO_UNSUPPORTED",
  });
}

async function pollDatabase(
  env: NodeJS.ProcessEnv,
  query: (client: AcceptanceQuery) => Promise<boolean>,
) {
  const databaseUrl = requireEnv(env, ["DATABASE_URL"]).DATABASE_URL;
  const timeoutMs = Number(env.ACCEPTANCE_POLL_TIMEOUT_MS ?? 120_000);
  const intervalMs = Number(env.ACCEPTANCE_POLL_INTERVAL_MS ?? 2_000);
  const { client } = createDatabase(databaseUrl);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await query(client as unknown as AcceptanceQuery)) return;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw Object.assign(new Error("Acceptance evidence timed out"), {
      code: "ACCEPTANCE_EVIDENCE_TIMEOUT",
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

type AcceptanceQuery = (
  strings: TemplateStringsArray,
  ...parameters: unknown[]
) => Promise<unknown[]>;

const metaStatusPriority: Record<string, number> = {
  failed: 5,
  read: 4,
  delivered: 3,
  sent: 2,
  pending: 1,
};

export function selectObservedMetaStatus(statuses: string[]): string {
  return statuses.reduce((selected, status) => {
    return (metaStatusPriority[status] ?? 0) >
      (metaStatusPriority[selected] ?? 0)
      ? status
      : selected;
  }, "");
}

async function runMetaDatabaseProbe(
  scenario: string,
  env: NodeJS.ProcessEnv,
): Promise<AcceptanceProbeResult> {
  if (scenario === "wait-status") {
    const providerMessageId = requireEnv(env, [
      "META_ACCEPTANCE_PROVIDER_MESSAGE_ID",
    ]).META_ACCEPTANCE_PROVIDER_MESSAGE_ID;
    let observedStatus = "";
    await pollDatabase(env, async (client) => {
      const rows = (await client`
        WITH observed AS (
          SELECT status::text
          FROM messages
          WHERE provider_message_id=${providerMessageId}
          UNION ALL
          SELECT status::text
          FROM pending_message_status_events
          WHERE provider_message_id=${providerMessageId}
        )
        SELECT status
        FROM observed
      `) as Array<{ status: string }>;
      observedStatus = selectObservedMetaStatus(rows.map((row) => row.status));
      if (observedStatus === "failed")
        throw Object.assign(new Error("Meta delivery failed"), {
          code: "META_DELIVERY_FAILED",
        });
      return ["delivered", "read"].includes(observedStatus);
    });
    return {
      evidence: {
        providerMessageIdHash: hashEvidence(providerMessageId),
        observedStatus,
      },
    };
  }
  if (scenario === "wait-inbound") {
    const marker = requireEnv(env, [
      "META_ACCEPTANCE_INBOUND_MARKER",
    ]).META_ACCEPTANCE_INBOUND_MARKER;
    await pollDatabase(env, async (client) => {
      const rows = (await client`
        SELECT EXISTS(
          SELECT 1
          FROM messages
          WHERE direction='inbound'
            AND body=${marker}
            AND created_at > now() - interval '30 minutes'
        ) AS found
      `) as Array<{ found: boolean }>;
      return rows[0]?.found === true;
    });
    return {
      evidence: {
        inboundObserved: true,
        markerHash: hashEvidence(marker),
      },
    };
  }
  throw Object.assign(new Error("Unsupported Meta database scenario"), {
    code: "ACCEPTANCE_SCENARIO_UNSUPPORTED",
  });
}

async function resolveBitrixCredentials(
  env: NodeJS.ProcessEnv,
): Promise<BitrixAcceptanceCredentials> {
  const portal = env.BITRIX24_ACCEPTANCE_PORTAL_URL?.replace(/\/$/, "");
  const webhookUrl = env.BITRIX24_WEBHOOK_URL;
  const accessToken = env.BITRIX24_ACCESS_TOKEN;
  if (webhookUrl || portal || accessToken) {
    if (!webhookUrl && (!portal || !accessToken))
      throw new MissingAcceptanceConfigurationError([
        "BITRIX24_WEBHOOK_URL or BITRIX24_ACCEPTANCE_PORTAL_URL+BITRIX24_ACCESS_TOKEN",
      ]);
    return {
      ...(webhookUrl ? { webhookUrl } : {}),
      ...(portal ? { portalUrl: portal } : {}),
      ...(accessToken ? { accessToken } : {}),
      source: "environment",
    };
  }

  const encryptionKey = requireEnv(env, [
    "APP_ENCRYPTION_KEY",
  ]).APP_ENCRYPTION_KEY;
  return withAcceptanceDatabase(env, async (client) => {
    const rows = (await client`
      SELECT public_id::text,portal_url,credentials_encrypted
      FROM integration_connections
      WHERE provider='bitrix24'
        AND status='connected'
        AND auth_mode<>'fake'
        AND credentials_encrypted IS NOT NULL
      ORDER BY created_at
    `) as Array<{
      public_id: string;
      portal_url: string | null;
      credentials_encrypted: string;
    }>;
    const row = selectAcceptanceRow(
      rows,
      env.BITRIX24_ACCEPTANCE_CONNECTION_PUBLIC_ID?.trim(),
      "BITRIX24_ACCEPTANCE_CONNECTION_PUBLIC_ID",
    );
    let decrypted: { webhookUrl?: unknown; accessToken?: unknown };
    try {
      decrypted = JSON.parse(
        decryptSecret(row.credentials_encrypted, encryptionKey),
      ) as { webhookUrl?: unknown; accessToken?: unknown };
    } catch {
      throw new MissingAcceptanceConfigurationError([
        "decryptable Bitrix24 connection credentials",
      ]);
    }
    const resolvedWebhook =
      typeof decrypted.webhookUrl === "string"
        ? decrypted.webhookUrl
        : undefined;
    const resolvedToken =
      typeof decrypted.accessToken === "string"
        ? decrypted.accessToken
        : undefined;
    const resolvedPortal = row.portal_url?.replace(/\/$/, "");
    if (!resolvedWebhook && (!resolvedPortal || !resolvedToken))
      throw new MissingAcceptanceConfigurationError([
        "usable Bitrix24 connection credentials",
      ]);
    return {
      ...(resolvedWebhook ? { webhookUrl: resolvedWebhook } : {}),
      ...(resolvedPortal ? { portalUrl: resolvedPortal } : {}),
      ...(resolvedToken ? { accessToken: resolvedToken } : {}),
      source: "encrypted-database",
    };
  });
}

async function bitrixProvider(env: NodeJS.ProcessEnv) {
  const credentials = await resolveBitrixCredentials(env);
  const client = new BitrixRestClient({
    ...(credentials.webhookUrl ? { webhookUrl: credentials.webhookUrl } : {}),
    ...(credentials.portalUrl ? { portalUrl: credentials.portalUrl } : {}),
    ...(credentials.accessToken
      ? { accessToken: credentials.accessToken }
      : {}),
    maxAttempts: 2,
  });
  return {
    client,
    provider: new Bitrix24Provider(client, credentials.portalUrl ?? "webhook"),
    portalHash: hashEvidence(
      credentials.portalUrl ?? credentials.webhookUrl ?? "unknown",
    ),
    credentialSource: credentials.source,
  };
}

async function runBitrixProbe(
  scenario: string,
  env: NodeJS.ProcessEnv,
  correlationId: string,
): Promise<AcceptanceProbeResult> {
  const { client, provider, portalHash, credentialSource } =
    await bitrixProvider(env);
  if (scenario === "health") {
    const result = await provider.health();
    return {
      evidence: {
        healthy: result.healthy,
        provider: result.provider,
        portalHash,
        credentialSource,
      },
    };
  }
  if (scenario === "crm-context") {
    const values = requireEnv(env, [
      "BITRIX24_ACCEPTANCE_ENTITY_TYPE",
      "BITRIX24_ACCEPTANCE_ENTITY_ID",
    ]);
    const entityType = values.BITRIX24_ACCEPTANCE_ENTITY_TYPE;
    if (!["contact", "lead", "deal", "company"].includes(entityType))
      throw Object.assign(new Error("Bitrix entity type is invalid"), {
        code: "BITRIX_ENTITY_TYPE_INVALID",
      });
    const context = await provider.getContext({
      entityType: entityType as "contact" | "lead" | "deal" | "company",
      externalId: values.BITRIX24_ACCEPTANCE_ENTITY_ID,
    });
    return {
      evidence: {
        contextLoaded: true,
        entityHash: hashEvidence(
          `${entityType}:${values.BITRIX24_ACCEPTANCE_ENTITY_ID}`,
        ),
        responsiblePresent: context.responsible !== null,
        portalHash,
      },
    };
  }
  if (scenario === "open-channels") {
    const response = await client.call<unknown[]>(
      "imopenlines.config.list.get",
    );
    return {
      evidence: {
        openChannelsReadable: true,
        configurationCount: Array.isArray(response.result)
          ? response.result.length
          : 0,
        portalHash,
      },
    };
  }
  if (scenario === "timeline") {
    requireConfirmation(env, "BITRIX24_ACCEPTANCE_CONFIRM", "MUTATE");
    const values = requireEnv(env, [
      "BITRIX24_ACCEPTANCE_ENTITY_TYPE",
      "BITRIX24_ACCEPTANCE_ENTITY_ID",
    ]);
    const result = await provider.addTimelineComment({
      entityType: values.BITRIX24_ACCEPTANCE_ENTITY_TYPE as
        "contact" | "lead" | "deal" | "company",
      externalId: values.BITRIX24_ACCEPTANCE_ENTITY_ID,
      text: `Brixchat24 acceptance ${correlationId}`,
      idempotencyKey: correlationId,
    });
    return {
      evidence: {
        timelineAccepted: true,
        timelineIdHash: hashEvidence(result.externalId),
        portalHash,
      },
    };
  }
  if (scenario === "assignment") {
    requireConfirmation(env, "BITRIX24_ACCEPTANCE_CONFIRM", "MUTATE");
    const values = requireEnv(env, [
      "BITRIX24_ACCEPTANCE_ENTITY_TYPE",
      "BITRIX24_ACCEPTANCE_ENTITY_ID",
      "BITRIX24_ACCEPTANCE_TEST_USER_ID",
      "BITRIX24_ACCEPTANCE_ORIGINAL_USER_ID",
    ]);
    const input = {
      entityType: values.BITRIX24_ACCEPTANCE_ENTITY_TYPE as
        "contact" | "lead" | "deal" | "company",
      externalId: values.BITRIX24_ACCEPTANCE_ENTITY_ID,
      idempotencyKey: correlationId,
    };
    try {
      await provider.updateResponsible({
        ...input,
        externalUserId: values.BITRIX24_ACCEPTANCE_TEST_USER_ID,
      });
    } finally {
      await provider.updateResponsible({
        ...input,
        externalUserId: values.BITRIX24_ACCEPTANCE_ORIGINAL_USER_ID,
      });
    }
    return {
      evidence: {
        assignmentChangedAndRestored: true,
        entityHash: hashEvidence(`${input.entityType}:${input.externalId}`),
        portalHash,
      },
    };
  }
  throw Object.assign(new Error("Unsupported Bitrix scenario"), {
    code: "ACCEPTANCE_SCENARIO_UNSUPPORTED",
  });
}

async function runStorageProbe(
  env: NodeJS.ProcessEnv,
  correlationId: string,
): Promise<AcceptanceProbeResult> {
  requireConfirmation(env, "STORAGE_ACCEPTANCE_CONFIRM", "ROUNDTRIP");
  const storage = createObjectStorageProvider(env);
  const health = await storage.healthCheck();
  if (!health.healthy || health.provider !== "s3")
    throw Object.assign(new Error("Storage health check failed"), {
      code: "STORAGE_HEALTH_FAILED",
    });
  const bytes = Buffer.from(`brixchat24-acceptance-${correlationId}`, "utf8");
  const key = `acceptance/${correlationId}.txt`;
  try {
    const stored = await storage.putObject({
      key,
      body: Readable.from(bytes),
      contentType: "text/plain",
    });
    const downloaded = Buffer.from(
      await new Response(await storage.getObject({ key })).arrayBuffer(),
    );
    if (!downloaded.equals(bytes))
      throw Object.assign(new Error("Storage round-trip mismatch"), {
        code: "STORAGE_ROUNDTRIP_MISMATCH",
      });
    return {
      evidence: {
        provider: health.provider,
        roundTrip: true,
        cleanupAttempted: true,
        size: stored.size,
        sha256: stored.sha256,
      },
    };
  } finally {
    await storage.deleteObject({ key });
  }
}

async function runMalwareProbe(
  env: NodeJS.ProcessEnv,
): Promise<AcceptanceProbeResult> {
  requireConfirmation(env, "MALWARE_ACCEPTANCE_CONFIRM", "EICAR");
  const scanner = createMalwareScanner(env);
  const health = await scanner.healthCheck();
  if (!health.healthy)
    throw Object.assign(new Error("Malware scanner health check failed"), {
      code: "MALWARE_HEALTH_FAILED",
    });
  const eicar = Buffer.from(
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" +
      "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  );
  const result = await scanner.scan({
    stream: Readable.toWeb(Readable.from(eicar)) as ReadableStream<Uint8Array>,
  });
  if (result.status !== "infected")
    throw Object.assign(new Error("EICAR was not detected"), {
      code: "MALWARE_EICAR_NOT_DETECTED",
    });
  return {
    evidence: {
      health: true,
      eicarDetected: true,
      signatureHash: hashEvidence(result.signature ?? "infected"),
    },
  };
}

async function runSmtpProbe(
  env: NodeJS.ProcessEnv,
  correlationId: string,
  scenario: string,
): Promise<AcceptanceProbeResult> {
  const values = requireEnv(env, ["SMTP_HOST", "EMAIL_FROM"]);
  const port = Number(env.SMTP_PORT ?? 587);
  const recipient =
    scenario === "all"
      ? requireEnv(env, ["SMTP_ACCEPTANCE_RECIPIENT"]).SMTP_ACCEPTANCE_RECIPIENT
      : undefined;
  if (scenario === "all")
    requireConfirmation(env, "SMTP_ACCEPTANCE_CONFIRM", "SEND");
  const provider = new SmtpEmailProvider(values.EMAIL_FROM, {
    host: values.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE === "true" || port === 465,
    ...(env.SMTP_USERNAME ? { username: env.SMTP_USERNAME } : {}),
    ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
  });
  await provider.verifyConnection();
  if (scenario === "verify")
    return {
      evidence: {
        connectionVerified: true,
        port,
      },
    };
  if (scenario !== "all")
    throw Object.assign(new Error("Unsupported SMTP scenario"), {
      code: "ACCEPTANCE_SCENARIO_UNSUPPORTED",
    });
  await provider.sendVerificationEmail({
    to: recipient as string,
    verificationUrl: `https://brixchat24.com/acceptance/${correlationId}`,
  });
  return {
    evidence: {
      connectionVerified: true,
      messageAccepted: true,
      recipientHash: hashEvidence(recipient as string),
      port,
    },
  };
}

export async function runAcceptanceProbe(input: {
  service: AcceptanceService;
  scenario: string;
  env?: NodeJS.ProcessEnv;
  correlationId?: string;
}): Promise<AcceptanceProbeResult> {
  const env = input.env ?? process.env;
  const correlationId = input.correlationId ?? randomUUID();
  if (
    input.service === "meta" &&
    ["wait-status", "wait-inbound"].includes(input.scenario)
  )
    return runMetaDatabaseProbe(input.scenario, env);
  if (input.service === "meta")
    return runMetaProbe(input.scenario, env, correlationId);
  if (input.service === "bitrix")
    return runBitrixProbe(input.scenario, env, correlationId);
  if (input.service === "storage") return runStorageProbe(env, correlationId);
  if (input.service === "malware") return runMalwareProbe(env);
  if (input.service === "smtp")
    return runSmtpProbe(env, correlationId, input.scenario);
  throw Object.assign(new Error("Unsupported acceptance service"), {
    code: "ACCEPTANCE_SERVICE_UNSUPPORTED",
  });
}
