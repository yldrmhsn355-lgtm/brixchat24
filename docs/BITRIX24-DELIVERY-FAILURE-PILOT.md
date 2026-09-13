# Bitrix24 Delivery Failure Pilot

This runbook validates the `message.delivery_failed` automation without
changing the active FlexInbox connection or sharing an Open Line between the
two applications.

## Safety boundaries

- Use a dedicated Brixchat24 Open Line that is not selected in FlexInbox.
- Do not disconnect, re-register, or rotate the active Meta WABA/webhook.
- Do not deliberately break billing, permissions, credentials, or media in
  production.
- Use a controlled test Lead/Deal and a dedicated `UF_CRM_*` test field.
- Keep the automation disabled until its trigger, channel scope, entity type,
  stage, and custom field are reviewed.

## Required configuration

1. Confirm the Brixchat24 channel is healthy and bound to the dedicated Bitrix
   Open Line.
2. Confirm the test conversation has an active `crm_entity_links` Lead or Deal
   record for the same Bitrix connection.
3. Create an automation with:
   - trigger: `message.delivery_failed`
   - channel scope: only the pilot channel
   - action: `update_bitrix_record`
   - target: the controlled stage and/or `UF_CRM_*` field
4. Publish the automation only after a dry-run/compiled-plan check succeeds.

## Acceptance matrix

| Provider reason | Category | CRM update |
| --- | --- | --- |
| Meta `131026` recipient unavailable | `recipient_unavailable` | Required |
| Meta `131050` recipient opted out | `recipient_opted_out` | Required |
| Meta `130472` experiment non-delivery | `provider_experiment` | Required |
| WhatsApp Web invalid recipient | `recipient_unavailable` | Required |
| Meta `131042` payment | `payment` | Must be blocked |
| Meta `131047` 24-hour window | `service_window` | Must be blocked |
| Meta `131053` media | `media` | Must be blocked |
| Meta `131056` rate limit | `rate_limit` | Must be blocked |
| Authentication, permission, credentials | `channel_configuration` | Must be blocked |
| Unknown provider/technical failure | `technical` | Must be blocked |

Use sanitized webhook fixtures in staging for payment, permission, media,
rate-limit, and service-window cases. Do not manufacture these failures on the
live WABA.

## Evidence to capture

- One `message_status_events` row for each provider callback.
- The final message status and normalized `error_code`.
- One deduplicated `automation_events` row with `failureCategory`,
  `customerRelated`, `automationEligible`, and `metaCode`.
- An automation run showing either a completed Bitrix update or the expected
  `automation_bitrix_delivery_failure_not_customer_related` block reason.
- The controlled Bitrix Lead/Deal audit trail confirming that excluded failure
  categories did not mutate CRM.

## Rollback

Disable the pilot automation first. This stops CRM mutations without changing
the Meta webhook, WhatsApp channel, Bitrix OAuth connection, connector, or Open
Line registration. Preserve the automation run and delivery-event records for
diagnosis.
