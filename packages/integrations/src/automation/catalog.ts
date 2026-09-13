export type AutomationAvailability = "available" | "planned";

export type AutomationTriggerDefinition = {
  type: string;
  label: string;
  description: string;
  availability: AutomationAvailability;
};

export type AutomationConditionFieldDefinition = {
  field: string;
  label: string;
  valueType: "string" | "number" | "boolean" | "date" | "string[]";
  availability: AutomationAvailability;
};

export type AutomationOperatorDefinition = {
  operator: string;
  label: string;
  valueRequired: boolean;
  availability: AutomationAvailability;
};

export type AutomationActionDefinition = {
  type: string;
  label: string;
  description: string;
  availability: AutomationAvailability;
};

export const automationTriggerCatalog: readonly AutomationTriggerDefinition[] =
  [
    {
      type: "message.received",
      label: "Mesaj alındı",
      description: "Yeni bir inbound mesaj canonical message akışına girdi.",
      availability: "available",
    },
    {
      type: "message.delivery_failed",
      label: "Mesaj teslim edilemedi",
      description:
        "Giden mesaj kalıcı bir sağlayıcı hatasıyla teslim edilemedi.",
      availability: "available",
    },
    {
      type: "group.message.received",
      label: "Grup mesajı alındı",
      description: "WhatsApp Web grubunda yeni bir mesaj alındı.",
      availability: "available",
    },
    {
      type: "group.mentioned",
      label: "Grupta kişi etiketlendi",
      description: "WhatsApp grup mesajında bir kişi etiketlendi.",
      availability: "available",
    },
    {
      type: "group.keyword_matched",
      label: "Grup anahtar kelimesi eşleşti",
      description: "WhatsApp grup mesajı yapılandırılan metinle eşleşti.",
      availability: "available",
    },
    ...(["added", "removed", "promoted", "demoted"] as const).map((event) => ({
      type: `group.participant_${event}`,
      label: `Grup katılımcısı ${event}`,
      description: "WhatsApp grubundaki katılımcı durumu değişti.",
      availability: "available" as const,
    })),
    {
      type: "conversation.created",
      label: "Konuşma oluşturuldu",
      description: "Yeni bir konuşma oluşturuldu.",
      availability: "available",
    },
    {
      type: "internal_note.created",
      label: "İç not oluşturuldu",
      description: "Ekip içi not oluşturuldu.",
      availability: "available",
    },
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
    ).map(([type, label]) => ({
      type,
      label,
      description: "Dosyalar ve Belgeler domain olayını işler.",
      availability: "available" as const,
    })),
    {
      type: "label_added",
      label: "Etiket eklendi",
      description: "Konuşmaya bir etiket eklendi.",
      availability: "available",
    },
    {
      type: "label_removed",
      label: "Etiket kaldırıldı",
      description: "Konuşmadan bir etiket kaldırıldı.",
      availability: "available",
    },
    {
      type: "conversation.assigned",
      label: "Konuşma atandı",
      description: "Konuşma kullanıcıya veya ekibe atandı.",
      availability: "planned",
    },
    {
      type: "conversation.status_changed",
      label: "Konuşma durumu değişti",
      description: "Açık, kapalı veya beklemede durumu değişti.",
      availability: "planned",
    },
    {
      type: "schedule.elapsed",
      label: "Süre doldu",
      description: "Son olaydan sonra belirlenen süre geçti.",
      availability: "planned",
    },
  ] as const;

export const automationConditionFieldCatalog: readonly AutomationConditionFieldDefinition[] =
  [
    {
      field: "channelId",
      label: "Kanal",
      valueType: "string",
      availability: "available",
    },
    {
      field: "provider",
      label: "Provider",
      valueType: "string",
      availability: "available",
    },
    {
      field: "text",
      label: "Mesaj metni",
      valueType: "string",
      availability: "available",
    },
    {
      field: "messageType",
      label: "Mesaj türü",
      valueType: "string",
      availability: "available",
    },
    {
      field: "direction",
      label: "Mesaj yönü",
      valueType: "string",
      availability: "available",
    },
    {
      field: "conversationId",
      label: "Konuşma",
      valueType: "string",
      availability: "available",
    },
    {
      field: "status",
      label: "Konuşma durumu",
      valueType: "string",
      availability: "available",
    },
    {
      field: "errorCode",
      label: "Teslimat hata kodu",
      valueType: "string",
      availability: "available",
    },
    {
      field: "retryable",
      label: "Yeniden denenebilir hata",
      valueType: "boolean",
      availability: "available",
    },
    {
      field: "failureCategory",
      label: "Teslimat hata kategorisi",
      valueType: "string",
      availability: "available",
    },
    {
      field: "customerRelated",
      label: "Müşteri/numara kaynaklı hata",
      valueType: "boolean",
      availability: "available",
    },
    {
      field: "automationEligible",
      label: "CRM otomasyonuna uygun hata",
      valueType: "boolean",
      availability: "available",
    },
    {
      field: "metaCode",
      label: "Meta hata kodu",
      valueType: "number",
      availability: "available",
    },
    {
      field: "priority",
      label: "Öncelik",
      valueType: "number",
      availability: "planned",
    },
    {
      field: "assigneeId",
      label: "Atanan kullanıcı",
      valueType: "string",
      availability: "planned",
    },
    {
      field: "teamId",
      label: "Atanan ekip",
      valueType: "string",
      availability: "planned",
    },
    {
      field: "labelId",
      label: "Etiket",
      valueType: "string",
      availability: "available",
    },
    {
      field: "contactId",
      label: "Kişi",
      valueType: "string",
      availability: "available",
    },
    {
      field: "contactLanguage",
      label: "Kişi dili",
      valueType: "string",
      availability: "planned",
    },
    {
      field: "contactPhone",
      label: "Kişi telefonu",
      valueType: "string",
      availability: "planned",
    },
    {
      field: "source",
      label: "Olay kaynağı",
      valueType: "string",
      availability: "available",
    },
    ...(
      [
        ["fileType", "Dosya türü", "string"],
        ["fileCategory", "Dosya kategorisi", "string"],
        ["fileSize", "Dosya boyutu", "number"],
        ["fileDirection", "Dosya yönü", "string"],
        ["storageConnectionId", "Drive bağlantısı", "string"],
        ["fileStatus", "İşlem durumu", "string"],
        ["hasTreatmentPlan", "Tedavi planı", "boolean"],
        ["classificationConfidence", "Sınıflandırma güveni", "number"],
      ] as const
    ).map(([field, label, valueType]) => ({
      field,
      label,
      valueType,
      availability: "available" as const,
    })),
  ] as const;

export const automationOperatorCatalog: readonly AutomationOperatorDefinition[] =
  [
    {
      operator: "equals",
      label: "eşittir",
      valueRequired: true,
      availability: "available",
    },
    {
      operator: "contains",
      label: "içerir",
      valueRequired: true,
      availability: "available",
    },
    {
      operator: "in",
      label: "listededir",
      valueRequired: true,
      availability: "available",
    },
    {
      operator: "exists",
      label: "mevcut",
      valueRequired: false,
      availability: "available",
    },
    {
      operator: "not_equals",
      label: "eşit değildir",
      valueRequired: true,
      availability: "available",
    },
    {
      operator: "not_contains",
      label: "içermez",
      valueRequired: true,
      availability: "available",
    },
    {
      operator: "starts_with",
      label: "şununla başlar",
      valueRequired: true,
      availability: "available",
    },
    {
      operator: "is_empty",
      label: "boştur",
      valueRequired: false,
      availability: "available",
    },
    {
      operator: "is_not_empty",
      label: "boş değildir",
      valueRequired: false,
      availability: "available",
    },
  ] as const;

export const automationActionCatalog: readonly AutomationActionDefinition[] = [
  {
    type: "add_label",
    label: "Etiket ekle",
    description: "Konuşmaya etiket ekler.",
    availability: "available",
  },
  {
    type: "remove_label",
    label: "Etiket kaldır",
    description: "Konuşmadan etiket kaldırır.",
    availability: "available",
  },
  {
    type: "assign_user",
    label: "Kullanıcı ata",
    description: "Konuşmayı bir kullanıcıya atar.",
    availability: "available",
  },
  {
    type: "send_whatsapp_template",
    label: "WhatsApp şablonu gönder",
    description: "Onaylı bir WhatsApp şablonunu outbox üzerinden gönderir.",
    availability: "available",
  },
  {
    type: "send_group_message",
    label: "Gruba mesaj gönder",
    description:
      "WhatsApp Web grup konuşmasına outbox üzerinden mesaj gönderir.",
    availability: "available",
  },
  {
    type: "send_message",
    label: "Serbest mesaj gönder",
    description:
      "Onaylı şablon gerekmeden, 24 saatlik müşteri hizmet penceresi açıkken serbest metin gönderir.",
    availability: "available",
  },
  {
    type: "create_bitrix_task",
    label: "Bitrix24 görevi oluştur",
    description: "Kanalın etkin Bitrix24 eşlemesi üzerinden görev açar.",
    availability: "available",
  },
  {
    type: "update_bitrix_record",
    label: "Bitrix24 kaydını güncelle",
    description:
      "Konuşmaya bağlı Lead veya Fırsat aşamasını ve isteğe bağlı özel alanını günceller.",
    availability: "available",
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
  ).map(([type, label]) => ({
    type,
    label,
    description:
      "Dosyalar ve Belgeler backend işlemini idempotent olarak yürütür.",
    availability: "available" as const,
  })),
  {
    type: "assign_team",
    label: "Ekip ata",
    description: "Konuşmayı bir ekibe atar.",
    availability: "planned",
  },
  {
    type: "set_conversation_status",
    label: "Konuşma durumunu değiştir",
    description: "Konuşmayı açık, beklemede veya kapalı yapar.",
    availability: "planned",
  },
  {
    type: "add_internal_note",
    label: "İç not ekle",
    description: "Konuşmaya ekip içi not ekler.",
    availability: "planned",
  },
  {
    type: "bitrix_timeline",
    label: "Bitrix24 timeline kaydı",
    description: "CRM timeline kuyruğuna kayıt bırakır.",
    availability: "planned",
  },
  {
    type: "webhook",
    label: "Webhook çağır",
    description: "İzin verilen HTTPS endpointine olay gönderir.",
    availability: "planned",
  },
] as const;

function available<
  T extends { type: string; availability: AutomationAvailability },
>(items: readonly T[], value: string) {
  return items.some(
    (item) => item.type === value && item.availability === "available",
  );
}

export function isSupportedAutomationTrigger(value: string) {
  return available(automationTriggerCatalog, value);
}

export function isKnownAutomationTrigger(value: string) {
  return automationTriggerCatalog.some((item) => item.type === value);
}

export function isAvailableAutomationAction(value: string) {
  return available(automationActionCatalog, value);
}

export function isKnownAutomationAction(value: string) {
  return automationActionCatalog.some((item) => item.type === value);
}

export function isKnownAutomationField(value: string) {
  return automationConditionFieldCatalog.some((item) => item.field === value);
}

export function isKnownAutomationOperator(value: string) {
  return automationOperatorCatalog.some((item) => item.operator === value);
}

export function isAvailableAutomationOperator(value: string) {
  return automationOperatorCatalog.some(
    (item) => item.operator === value && item.availability === "available",
  );
}
