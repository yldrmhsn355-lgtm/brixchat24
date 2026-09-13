import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  AutomationInputPort,
  AutomationPlatformNodeCategory,
  AutomationOutputPort,
} from "./contracts";

export type AutomationRuntimeCapability =
  "production" | "dry-run-only" | "planned";

export type AutomationNodeDefinition = {
  type: string;
  version: number;
  displayName: string;
  description: string;
  category: AutomationPlatformNodeCategory;
  icon: string;
  color: string;
  configSchema: z.ZodType;
  inputPorts: AutomationInputPort[];
  outputPorts: AutomationOutputPort[];
  availability: "available" | "planned";
  runtimeCapability: AutomationRuntimeCapability;
  handlerKey: string | null;
};

function registryKey(type: string, version: number) {
  return `${type}@${version}`;
}

export class AutomationNodeRegistry {
  readonly #definitions = new Map<string, AutomationNodeDefinition>();

  constructor(definitions: readonly AutomationNodeDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: AutomationNodeDefinition) {
    const key = registryKey(definition.type, definition.version);
    if (this.#definitions.has(key))
      throw new Error(`automation_registry_duplicate:${key}`);
    if (definition.runtimeCapability === "production" && !definition.handlerKey)
      throw new Error(`automation_registry_handler_missing:${key}`);
    this.#definitions.set(key, definition);
    return this;
  }

  get(type: string, version: number) {
    return this.#definitions.get(registryKey(type, version));
  }

  list() {
    return [...this.#definitions.values()].sort(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.displayName.localeCompare(right.displayName) ||
        left.version - right.version,
    );
  }

  listPublishable() {
    return this.list().filter(
      (definition) =>
        definition.availability === "available" &&
        definition.runtimeCapability === "production" &&
        Boolean(definition.handlerKey),
    );
  }
}

const inputPort: AutomationInputPort = {
  id: "input",
  kind: "control",
  required: true,
};
const successPort: AutomationOutputPort = {
  id: "success",
  kind: "success",
  required: true,
};
const errorPort: AutomationOutputPort = {
  id: "error",
  kind: "error",
  required: false,
};

const channelScopeSchema = z
  .object({
    mode: z
      .enum(["selected", "all_current", "all_current_and_future"])
      .default("all_current_and_future"),
    channelIds: z.array(z.string().uuid()).max(100).default([]),
    excludedChannelIds: z.array(z.string().uuid()).max(100).default([]),
  })
  .superRefine((scope, context) => {
    if (scope.mode === "selected" && !scope.channelIds.length)
      context.addIssue({
        code: "custom",
        message: "automation_channel_scope_empty",
        path: ["channelIds"],
      });
  });

const baseDefinition = {
  version: 1,
  availability: "available" as const,
  runtimeCapability: "production" as const,
};
const optionalFileAsset = { fileAssetId: z.string().uuid().optional() };
function fileActionSchema(type: string): z.ZodType {
  if (type === "move_file")
    return z
      .object({
        ...optionalFileAsset,
        folderId: z.string().trim().min(1).max(300),
      })
      .strict();
  if (type === "rename_file")
    return z
      .object({ ...optionalFileAsset, name: z.string().trim().min(1).max(180) })
      .strict();
  if (type === "assign_file_category")
    return z
      .object({
        ...optionalFileAsset,
        category: z.enum([
          "incoming_media",
          "intraoral_photos",
          "xray_cbct",
          "treatment_plans",
          "offers",
          "consent_reports",
          "invoices_payments",
          "other",
        ]),
      })
      .strict();
  if (type === "create_file_share")
    return z
      .object({
        ...optionalFileAsset,
        emailAddress: z.string().email().optional(),
        allowPublic: z.boolean().default(false),
      })
      .refine(
        (value) => Boolean(value.emailAddress || value.allowPublic),
        "automation_file_share_target_required",
      );
  if (type === "revoke_file_share")
    return z
      .object({
        ...optionalFileAsset,
        permissionId: z.string().trim().min(1).max(300),
      })
      .strict();
  if (type === "assign_file_task")
    return z
      .object({
        ...optionalFileAsset,
        userId: z.string().uuid(),
        title: z.string().trim().min(2).max(240),
      })
      .strict();
  if (type === "notify_file")
    return z
      .object({
        ...optionalFileAsset,
        userId: z.string().uuid(),
        message: z.string().trim().min(1).max(1000),
      })
      .strict();
  return z.object(optionalFileAsset).strict();
}

export const builtinAutomationNodeDefinitions: readonly AutomationNodeDefinition[] =
  [
    {
      ...baseDefinition,
      type: "message.received",
      displayName: "Mesaj alındı",
      description: "Canonical inbound mesaj olayıyla akışı başlatır.",
      category: "trigger",
      icon: "message-circle",
      color: "green",
      configSchema: z
        .object({
          channelScope: channelScopeSchema.default({
            mode: "all_current_and_future",
            channelIds: [],
            excludedChannelIds: [],
          }),
          inboundOnly: z.boolean().default(true),
          excludeBotMessages: z.boolean().default(true),
          excludeSystemMessages: z.boolean().default(true),
          messageTypes: z.array(z.string().min(1)).max(20).default([]),
          cooldownSeconds: z.number().int().min(0).max(2_592_000).default(0),
          maxRunsPerConversation: z
            .number()
            .int()
            .min(1)
            .max(1_000)
            .default(100),
        })
        .strict(),
      inputPorts: [],
      outputPorts: [successPort],
      handlerKey: "trigger.message.received",
    },
    {
      ...baseDefinition,
      type: "message.delivery_failed",
      displayName: "Mesaj teslim edilemedi",
      description:
        "Giden mesaj kalıcı bir sağlayıcı hatasıyla teslim edilemediğinde akışı başlatır.",
      category: "trigger",
      icon: "message-circle-x",
      color: "red",
      configSchema: z
        .object({
          channelScope: channelScopeSchema.default({
            mode: "all_current_and_future",
            channelIds: [],
            excludedChannelIds: [],
          }),
        })
        .strict(),
      inputPorts: [],
      outputPorts: [successPort],
      handlerKey: "trigger.message.delivery_failed",
    },
    {
      ...baseDefinition,
      type: "group.message.received",
      displayName: "Grup mesajı alındı",
      description:
        "WhatsApp Web grup sohbetindeki yeni mesajla akışı başlatır.",
      category: "trigger",
      icon: "users",
      color: "green",
      configSchema: z
        .object({
          channelScope: channelScopeSchema.default({
            mode: "all_current_and_future",
            channelIds: [],
            excludedChannelIds: [],
          }),
          messageTypes: z.array(z.string().min(1)).max(20).default([]),
        })
        .strict(),
      inputPorts: [],
      outputPorts: [successPort],
      handlerKey: "trigger.group.message.received",
    },
    {
      ...baseDefinition,
      type: "group.mentioned",
      displayName: "Grupta kişi etiketlendi",
      description:
        "Grup mesajında herhangi veya seçili bir kişi etiketlendiğinde çalışır.",
      category: "trigger",
      icon: "at-sign",
      color: "green",
      configSchema: z
        .object({
          channelScope: channelScopeSchema.default({
            mode: "all_current_and_future",
            channelIds: [],
            excludedChannelIds: [],
          }),
          mentionMode: z.enum(["any", "selected"]).default("any"),
          mentionedJids: z.array(z.string().trim().min(3)).max(100).default([]),
        })
        .superRefine((config, context) => {
          if (config.mentionMode === "selected" && !config.mentionedJids.length)
            context.addIssue({
              code: "custom",
              message: "automation_group_mentions_empty",
              path: ["mentionedJids"],
            });
        }),
      inputPorts: [],
      outputPorts: [successPort],
      handlerKey: "trigger.group.mentioned",
    },
    {
      ...baseDefinition,
      type: "group.keyword_matched",
      displayName: "Grup anahtar kelimesi",
      description:
        "Grup mesajı yapılandırılan güvenli metin eşleşmesine uyduğunda çalışır.",
      category: "trigger",
      icon: "text-search",
      color: "green",
      configSchema: z
        .object({
          channelScope: channelScopeSchema.default({
            mode: "all_current_and_future",
            channelIds: [],
            excludedChannelIds: [],
          }),
          keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
          matchMode: z.enum(["any", "all"]).default("any"),
          caseSensitive: z.boolean().default(false),
        })
        .strict(),
      inputPorts: [],
      outputPorts: [successPort],
      handlerKey: "trigger.group.keyword_matched",
    },
    ...(["added", "removed", "promoted", "demoted"] as const).map((event) => ({
      ...baseDefinition,
      type: `group.participant_${event}`,
      displayName: `Grup katılımcısı ${
        event === "added"
          ? "eklendi"
          : event === "removed"
            ? "çıkarıldı"
            : event === "promoted"
              ? "yönetici yapıldı"
              : "yöneticilikten alındı"
      }`,
      description:
        "WhatsApp grubundaki katılımcı değişikliğiyle akışı başlatır.",
      category: "trigger" as const,
      icon: "user-cog",
      color: "green",
      configSchema: z
        .object({
          channelScope: channelScopeSchema.default({
            mode: "all_current_and_future",
            channelIds: [],
            excludedChannelIds: [],
          }),
          participantJids: z
            .array(z.string().trim().min(3))
            .max(100)
            .default([]),
        })
        .strict(),
      inputPorts: [],
      outputPorts: [successPort],
      handlerKey: `trigger.group.participant_${event}`,
    })),
    ...(
      [
        ["file.received", "Dosya alındı"],
        ["file.uploaded", "Dosya Drive'a yüklendi"],
        ["file.xray_detected", "Röntgen tespit edildi"],
        ["file.document_created", "Belge oluşturuldu"],
        ["file.changed", "Dosya değiştirildi"],
        ["file.deleted", "Dosya silindi"],
        ["file.upload_failed", "Dosya yüklemesi başarısız"],
        ["file.folder_created", "Hasta klasörü oluşturuldu"],
        ["file.permission_changed", "Paylaşım izni değiştirildi"],
      ] as const
    ).map(([type, displayName]) => ({
      ...baseDefinition,
      type,
      displayName,
      description: "Dosyalar ve Belgeler domain olayıyla akışı başlatır.",
      category: "trigger" as const,
      icon: "folder-open",
      color: "indigo",
      configSchema: z.object({}).strict(),
      inputPorts: [],
      outputPorts: [successPort],
      handlerKey: `trigger.${type}`,
    })),
    {
      ...baseDefinition,
      type: "condition.evaluate",
      displayName: "Koşulu değerlendir",
      description:
        "Canonical event alanını güvenli bir operatörle değerlendirir.",
      category: "condition",
      icon: "split",
      color: "amber",
      configSchema: z
        .object({
          field: z.string().trim().min(1).max(128),
          operator: z.enum([
            "equals",
            "not_equals",
            "contains",
            "not_contains",
            "starts_with",
            "in",
            "exists",
            "is_empty",
            "is_not_empty",
          ]),
          value: z.unknown().optional(),
          normalization: z
            .object({
              caseSensitive: z.boolean().default(false),
              unicode: z.boolean().default(true),
              punctuation: z.boolean().default(false),
              whitespace: z.boolean().default(true),
            })
            .default({
              caseSensitive: false,
              unicode: true,
              punctuation: false,
              whitespace: true,
            }),
        })
        .strict(),
      inputPorts: [inputPort],
      outputPorts: [
        { id: "true", kind: "true", required: true },
        { id: "false", kind: "false", required: true },
      ],
      handlerKey: "condition.evaluate",
    },
    {
      ...baseDefinition,
      type: "add_label",
      displayName: "Etiket ekle",
      description: "Conversation'a tenant kapsamındaki etkin etiketi ekler.",
      category: "conversation",
      icon: "tag",
      color: "indigo",
      configSchema: z.object({ labelId: z.string().uuid() }).strict(),
      inputPorts: [inputPort],
      outputPorts: [successPort, errorPort],
      handlerKey: "action.add_label",
    },
    {
      ...baseDefinition,
      type: "remove_label",
      displayName: "Etiket kaldır",
      description: "Conversation'dan tenant kapsamındaki etiketi kaldırır.",
      category: "conversation",
      icon: "tag-off",
      color: "indigo",
      configSchema: z.object({ labelId: z.string().uuid() }).strict(),
      inputPorts: [inputPort],
      outputPorts: [successPort, errorPort],
      handlerKey: "action.remove_label",
    },
    {
      ...baseDefinition,
      type: "assign_user",
      displayName: "Temsilciye ata",
      description: "Conversation'ı etkin ve erişilebilir temsilciye atar.",
      category: "assignment",
      icon: "user-check",
      color: "blue",
      configSchema: z.object({ userId: z.string().uuid() }).strict(),
      inputPorts: [inputPort],
      outputPorts: [successPort, errorPort],
      handlerKey: "action.assign_user",
    },
    {
      ...baseDefinition,
      type: "send_whatsapp_template",
      displayName: "WhatsApp template gönder",
      description:
        "Onaylı template mesajını canonical transactional outbox üzerinden gönderir.",
      category: "messaging",
      icon: "send",
      color: "green",
      configSchema: z
        .object({
          templateId: z.string().uuid(),
          channelId: z.string().uuid(),
          languagePolicy: z.enum(["contact", "fixed"]).default("contact"),
          fixedLanguage: z.string().trim().min(2).max(16).optional(),
          requireOptIn: z.boolean().default(true),
          repeatLimitMinutes: z
            .number()
            .int()
            .min(1)
            .max(525_600)
            .default(1_440),
          variableValues: z.record(z.string(), z.string()).default({}),
        })
        .strict(),
      inputPorts: [inputPort],
      outputPorts: [successPort, errorPort],
      handlerKey: "action.send_whatsapp_template",
    },
    {
      ...baseDefinition,
      type: "send_group_message",
      displayName: "Gruba mesaj gönder",
      description:
        "Geçerli WhatsApp Web grup konuşmasına transactional outbox üzerinden yanıt gönderir.",
      category: "messaging",
      icon: "messages-square",
      color: "green",
      configSchema: z
        .object({
          text: z.string().trim().min(1).max(4096),
          mentionedJids: z.array(z.string().trim().min(3)).max(100).default([]),
        })
        .strict(),
      inputPorts: [inputPort],
      outputPorts: [successPort, errorPort],
      handlerKey: "action.send_group_message",
    },
    {
      ...baseDefinition,
      type: "send_message",
      displayName: "Serbest mesaj gönder",
      description:
        "Şablona bağlı olmadan, aktif 24 saatlik müşteri hizmet penceresi içinde serbest metin gönderir.",
      category: "messaging",
      icon: "message-circle",
      color: "green",
      configSchema: z
        .object({
          text: z.string().trim().min(1).max(4096),
        })
        .strict(),
      inputPorts: [inputPort],
      outputPorts: [successPort, errorPort],
      handlerKey: "action.send_message",
    },
    {
      ...baseDefinition,
      type: "create_bitrix_task",
      displayName: "Bitrix24 görevi oluştur",
      description:
        "Kanalın etkin Bitrix24 eşlemesi üzerinden sorumlu kullanıcıya görev açar.",
      category: "crm",
      icon: "list-checks",
      color: "blue",
      configSchema: z
        .object({
          title: z.string().trim().min(2).max(255),
          description: z.string().trim().max(5000).default(""),
          responsibleExternalUserId: z.string().regex(/^\d+$/),
        })
        .strict(),
      inputPorts: [inputPort],
      outputPorts: [successPort, errorPort],
      handlerKey: "action.create_bitrix_task",
    },
    {
      ...baseDefinition,
      type: "update_bitrix_record",
      displayName: "Bitrix24 kaydını güncelle",
      description:
        "Konuşmaya bağlı Lead veya Fırsat aşamasını ve isteğe bağlı özel alanını günceller.",
      category: "crm",
      icon: "refresh-cw",
      color: "blue",
      configSchema: z
        .object({
          entityType: z.enum(["lead", "deal"]),
          stageId: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9:_-]{1,100}$/)
            .or(z.literal(""))
            .optional(),
          customFieldId: z
            .string()
            .trim()
            .regex(/^UF_CRM_[A-Z0-9_]{1,64}$/)
            .or(z.literal(""))
            .optional(),
          customFieldValue: z.string().trim().max(1000).optional(),
        })
        .strict()
        .superRefine((config, context) => {
          if (!config.stageId && !config.customFieldId)
            context.addIssue({
              code: "custom",
              message: "automation_bitrix_update_target_missing",
            });
          if (config.customFieldId && config.customFieldValue === undefined)
            context.addIssue({
              code: "custom",
              message: "automation_bitrix_custom_field_value_missing",
              path: ["customFieldValue"],
            });
        }),
      inputPorts: [inputPort],
      outputPorts: [successPort, errorPort],
      handlerKey: "action.update_bitrix_record",
    },
    ...(
      [
        ["create_patient_folder", "Hasta klasörü oluştur"],
        ["upload_drive", "Drive'a yükle"],
        ["move_file", "Dosyayı taşı"],
        ["rename_file", "Yeniden adlandır"],
        ["assign_file_category", "Kategori ata"],
        ["send_file_whatsapp", "WhatsApp'tan gönder"],
        ["create_file_share", "Paylaşım bağlantısı oluştur"],
        ["revoke_file_share", "Paylaşımı iptal et"],
        ["archive_file", "Dosyayı arşivle"],
        ["assign_file_task", "Kullanıcıya görev ata"],
        ["notify_file", "Bildirim gönder"],
      ] as const
    ).map(([type, displayName]) => ({
      ...baseDefinition,
      type,
      displayName,
      description:
        "Dosyalar ve Belgeler backend işlemini idempotent olarak yürütür.",
      category: "integration" as const,
      icon: "folder-cog",
      color: "indigo",
      configSchema: fileActionSchema(type),
      inputPorts: [inputPort],
      outputPorts: [successPort, errorPort],
      handlerKey: `action.${type}`,
    })),
    {
      type: "branch.boolean",
      version: 1,
      displayName: "Evet / Hayır",
      description: "Boolean sonucu iki adlandırılmış dala yönlendirir.",
      category: "control",
      icon: "git-branch",
      color: "amber",
      configSchema: z.object({}).strict(),
      inputPorts: [inputPort],
      outputPorts: [
        { id: "true", kind: "true", required: true },
        { id: "false", kind: "false", required: true },
      ],
      availability: "planned",
      runtimeCapability: "planned",
      handlerKey: null,
    },
    {
      type: "wait.duration",
      version: 1,
      displayName: "Süre bekle",
      description: "Execution'ı kalıcı bir continuation ile askıya alır.",
      category: "time",
      icon: "clock",
      color: "rose",
      configSchema: z
        .object({
          duration: z.number().int().min(1),
          unit: z.enum(["seconds", "minutes", "hours", "days"]),
          calendarMode: z.enum(["calendar", "business"]).default("calendar"),
          timezone: z.string().trim().min(1).default("Europe/Istanbul"),
        })
        .strict(),
      inputPorts: [inputPort],
      outputPorts: [
        successPort,
        { id: "timeout", kind: "timeout", required: false },
        errorPort,
        { id: "cancelled", kind: "cancelled", required: false },
      ],
      availability: "planned",
      runtimeCapability: "planned",
      handlerKey: null,
    },
    {
      type: "wait.customer_reply",
      version: 1,
      displayName: "Müşteri yanıtını bekle",
      description:
        "Canonical inbound message olayına kadar execution'ı askıya alır.",
      category: "time",
      icon: "message-square-reply",
      color: "rose",
      configSchema: z
        .object({
          timeoutSeconds: z.number().int().min(1).max(2_592_000),
          resetPolicy: z.enum(["keep", "reset"]).default("keep"),
        })
        .strict(),
      inputPorts: [inputPort],
      outputPorts: [
        successPort,
        { id: "timeout", kind: "timeout", required: true },
        errorPort,
        { id: "cancelled", kind: "cancelled", required: false },
      ],
      availability: "planned",
      runtimeCapability: "planned",
      handlerKey: null,
    },
    {
      type: "wait.agent_reply",
      version: 1,
      displayName: "Temsilci yanıtını bekle",
      description:
        "İnsan temsilcinin canonical outbound mesajına kadar execution'ı askıya alır.",
      category: "time",
      icon: "headset",
      color: "rose",
      configSchema: z
        .object({
          timeoutSeconds: z.number().int().min(1).max(2_592_000),
          resetPolicy: z.enum(["keep", "reset"]).default("keep"),
        })
        .strict(),
      inputPorts: [inputPort],
      outputPorts: [
        successPort,
        { id: "timeout", kind: "timeout", required: true },
        errorPort,
        { id: "cancelled", kind: "cancelled", required: false },
      ],
      availability: "planned",
      runtimeCapability: "planned",
      handlerKey: null,
    },
  ];

export const builtinAutomationNodeRegistry = new AutomationNodeRegistry(
  builtinAutomationNodeDefinitions,
);

export function automationNodeCatalog() {
  return builtinAutomationNodeRegistry.list().map((definition) => ({
    type: definition.type,
    version: definition.version,
    displayName: definition.displayName,
    description: definition.description,
    category: definition.category,
    icon: definition.icon,
    color: definition.color,
    configSchema: zodToJsonSchema(definition.configSchema, {
      target: "openApi3",
    }),
    inputPorts: definition.inputPorts,
    outputPorts: definition.outputPorts,
    availability: definition.availability,
    runtimeCapability: definition.runtimeCapability,
  }));
}
