# Channels modular architecture

The channels core is provider-neutral. A platform module owns its provider
identity, capability manifest and adapter boundary; API routes, repositories,
outbox processing and the inbox consume the shared messaging contracts.

```text
channels core
  ├─ messagingProviderModules registry
  ├─ provider catalog (configuration/capabilities/availability)
  ├─ canonical conversation/contact/message repository
  └─ outbox + webhook/event normalization

platform modules
  ├─ whatsapp.cloud       -> MetaWhatsAppCloudProvider
  ├─ whatsapp.web          -> separate Baileys worker runtime
  ├─ instagram.direct      -> coming soon
  ├─ facebook.messenger    -> coming soon
  ├─ telegram.bot          -> coming soon
  ├─ sms.twilio            -> coming soon
  ├─ email.smtp            -> coming soon
  └─ webchat.brixchat      -> coming soon
```

The registry is intentionally separate from the catalog. The catalog describes
what the UI/API may expose; the module registry resolves the adapter without a
provider-name conditional chain. A future module only needs to add its manifest
and adapter implementation; canonical message persistence remains unchanged.

Every module also declares the Bitrix24 CRM contract: inbound events first land
in the canonical message repository, outbound events leave through the shared
message outbox, and timeline synchronization is scheduled through the shared
`crm_sync_jobs` path. Open Channels source markers include channel, provider and
provider message identity, so multiple platforms cannot collide in Bitrix.

WhatsApp Web is kept in the registry as a `worker_runtime` module so its QR,
session and Baileys lifecycle cannot be mixed into the Cloud API adapter. It is
currently `coming_soon` and disabled in production.
