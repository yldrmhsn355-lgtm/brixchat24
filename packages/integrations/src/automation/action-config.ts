// Shared between the API (save/publish validation) and the worker
// (runtime guard): an action config rejected here must never reach a
// published version, and the runtime blocks it defensively if one does.
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredUuid(
  config: Record<string, unknown>,
  key: string,
  code: string,
) {
  const value = config[key];
  return typeof value === "string" && uuidPattern.test(value) ? null : code;
}

export function automationActionConfigError(
  actionType: string,
  config: Record<string, unknown>,
) {
  if (actionType === "add_label" || actionType === "remove_label")
    return requiredUuid(config, "labelId", "automation_label_id_missing");
  if (actionType === "assign_user")
    return requiredUuid(config, "userId", "automation_user_id_missing");
  if (actionType === "send_whatsapp_template")
    return (
      requiredUuid(config, "templateId", "automation_template_id_missing") ??
      requiredUuid(config, "channelId", "automation_channel_id_missing")
    );
  if (actionType === "send_group_message") {
    const text = config.text;
    if (
      typeof text !== "string" ||
      text.trim().length < 1 ||
      text.trim().length > 4096
    )
      return "automation_group_message_text_invalid";
    if (
      config.mentionedJids !== undefined &&
      (!Array.isArray(config.mentionedJids) ||
        config.mentionedJids.some(
          (jid) => typeof jid !== "string" || jid.trim().length < 3,
        ))
    )
      return "automation_group_message_mentions_invalid";
  }
  if (actionType === "send_message") {
    const text = config.text;
    if (
      typeof text !== "string" ||
      text.trim().length < 1 ||
      text.trim().length > 4096
    )
      return "automation_message_text_invalid";
  }
  if (actionType === "create_bitrix_task") {
    if (
      typeof config.title !== "string" ||
      config.title.trim().length < 2 ||
      config.title.trim().length > 255
    )
      return "automation_bitrix_task_title_invalid";
    if (
      typeof config.responsibleExternalUserId !== "string" ||
      !/^\d+$/.test(config.responsibleExternalUserId)
    )
      return "automation_bitrix_responsible_id_invalid";
  }
  if (actionType === "update_bitrix_record") {
    if (config.entityType !== "lead" && config.entityType !== "deal")
      return "automation_bitrix_entity_type_invalid";
    const stageId =
      typeof config.stageId === "string"
        ? config.stageId.trim()
        : config.stageId;
    const customFieldId =
      typeof config.customFieldId === "string"
        ? config.customFieldId.trim()
        : config.customFieldId;
    if (
      stageId !== undefined &&
      stageId !== "" &&
      (typeof stageId !== "string" ||
        !/^[A-Za-z0-9:_-]{1,100}$/.test(stageId.trim()))
    )
      return "automation_bitrix_stage_id_invalid";
    if (
      customFieldId !== undefined &&
      customFieldId !== "" &&
      (typeof customFieldId !== "string" ||
        !/^UF_CRM_[A-Z0-9_]{1,64}$/.test(customFieldId.trim()))
    )
      return "automation_bitrix_custom_field_id_invalid";
    if (!stageId && !customFieldId)
      return "automation_bitrix_update_target_missing";
    if (
      customFieldId &&
      (typeof config.customFieldValue !== "string" ||
        config.customFieldValue.trim().length > 1000)
    )
      return "automation_bitrix_custom_field_value_invalid";
  }
  const fileActions = new Set([
    "create_patient_folder",
    "upload_drive",
    "send_file_whatsapp",
    "archive_file",
  ]);
  if (fileActions.has(actionType) && config.fileAssetId !== undefined)
    return requiredUuid(
      config,
      "fileAssetId",
      "automation_file_asset_id_invalid",
    );
  if (actionType === "move_file") {
    if (config.fileAssetId !== undefined) {
      const invalid = requiredUuid(
        config,
        "fileAssetId",
        "automation_file_asset_id_invalid",
      );
      if (invalid) return invalid;
    }
    if (typeof config.folderId !== "string" || !config.folderId.trim())
      return "automation_file_folder_id_missing";
  }
  if (
    actionType === "rename_file" &&
    (typeof config.name !== "string" || !config.name.trim())
  )
    return "automation_file_name_missing";
  if (
    actionType === "assign_file_category" &&
    typeof config.category !== "string"
  )
    return "automation_file_category_missing";
  if (
    actionType === "create_file_share" &&
    !config.emailAddress &&
    config.allowPublic !== true
  )
    return "automation_file_share_target_missing";
  if (
    actionType === "revoke_file_share" &&
    (typeof config.permissionId !== "string" || !config.permissionId)
  )
    return "automation_file_permission_id_missing";
  if (actionType === "assign_file_task")
    return (
      requiredUuid(config, "userId", "automation_file_task_user_missing") ??
      (typeof config.title !== "string" || !config.title.trim()
        ? "automation_file_task_title_missing"
        : null)
    );
  if (actionType === "notify_file")
    return (
      requiredUuid(
        config,
        "userId",
        "automation_file_notification_user_missing",
      ) ??
      (typeof config.message !== "string" || !config.message.trim()
        ? "automation_file_notification_message_missing"
        : null)
    );
  return null;
}
