# WhatsApp Cloud Inbox Parity Audit

Audit date: 2026-07-18
Scope: Meta WhatsApp Cloud API, multi-channel Inbox, webhook, media, realtime and production gates. CRM/Bitrix/Open Channels behavior is intentionally out of scope.

## Mevcut Mimari

- Fastify API: `apps/api/src/app.ts`, `apps/api/src/product-routes.ts`, `apps/api/src/milestone5-routes.ts`.
- Durable persistence: PostgreSQL repositories in `packages/database/src/repositories/`; webhook, message, outbox and media-processing tables are migration-backed.
- Worker: `apps/worker/src/index.ts` claims webhook, outbox and media jobs, decrypts channel credentials and calls the selected provider.
- Provider: `packages/integrations/src/meta-whatsapp/provider.ts` and `fake/provider.ts`; provider selection is centralized in `createMessagingProvider`.
- Realtime: Redis publication plus short-lived SSE token flow in API and Inbox reconciliation in `apps/web/app/app/inbox/workspace.tsx`.
- Frontend: Next.js Inbox uses the server conversation/message APIs, channel selector, media preview and reaction controls.

Data flow: Meta webhook -> raw-body/HMAC verification -> durable webhook event -> worker claim -> contact -> channel-scoped conversation -> idempotent message -> unread/service-window update -> Redis/SSE event -> Inbox reconciliation/render.

## Korunacak Özellikler

| Alan | Durum | Kod/test karşılığı |
|---|---|---|
| Tenant auth/RBAC | verified | `apps/api/src/app.ts`, `apps/api/src/product-routes.ts`, `apps/api/src/app.test.ts` |
| Meta provider/fake development provider | verified | `packages/integrations/src/messaging`, provider factory |
| Webhook GET/HMAC/raw body | verified | `apps/api/src/app.ts`, `packages/integrations/src/messaging/utils.ts` |
| Durable webhook/outbox/media jobs | verified | `packages/database/migrations`, `apps/worker/src/index.ts` |
| Channel/phone_number_id outbound routing | verified | worker delivery context and Meta provider |
| Idempotent inbound/outbound | verified | repository unique keys and client message ID |
| Status monotonicity | verified | status repository/tests |
| 24-hour service window/templates | verified | `MessageRepository.createOutbound`, template routes |
| Private media and signed URLs | partially_verified | attachment routes and local/S3 abstraction |
| SSE/reconciliation | partially_verified | realtime token/SSE plus Inbox polling fallback |
| Channel selector/RBAC | partially_verified | `/api/v1/inbox/whatsapp-accounts`, conversation query |
| Cursor pagination | partially_verified | repository cursor exists; Inbox load-more contract needs E2E proof |
| Channel health | partially_verified | health route/provider check exists; status taxonomy/metadata coverage is incomplete |

## Gerçek Açıklar

1. Health status is still partly represented by channel `status`/credential presence; the complete diagnostics taxonomy and webhook freshness fields need enforcement.
2. Meta dashboard test and unknown `metadata.phone_number_id` events need explicit quarantine/unmatched handling rather than normal inbound processing.
3. Inbox still uses a periodic three-second reconciliation loop in normal operation; it should be SSE-first with polling only during recovery/offline states.
4. Facet/count filters and URL-as-source-of-truth channel selection are incomplete compared with the parity contract.
5. Production Compose must fail-fast for local object storage and `NoopMalwareScanner`; local development remains allowed.
6. Full external Meta acceptance and negative routing acceptance require a controlled external WhatsApp sender and must remain `EXTERNAL ACCEPTANCE PENDING` until run.

## Riskler

- Wrong phone-number routing or dashboard test payload can create a false customer conversation.
- Reaction messages must not increment unread or replace the target conversation last-message semantics.
- Realtime duplicates/reconnects can race with reconciliation unless event identity/version guards are enforced.
- Production local storage/noop scanner would weaken media isolation and malware guarantees.
- Secrets are encrypted/hashed and are not returned, but acceptance must continue to check logs and response bodies for leakage.

## Acceptance Classification

- Local code/runtime: `partially_verified`.
- Real Meta inbound/outbound traffic: `external_acceptance_required`.
- Production readiness: `external_acceptance_required` until storage/scanner and live negative tests are proven.

This audit is the baseline for the remaining implementation; existing working migrations and provider flows are preserved.

## Bu audit sonrasÄ± uygulanan dÃ¼zeltmeler

- Meta webhook POST'unda payload `metadata.phone_number_id` deÄŸerleri URL channel'Ä± ile karÅŸÄ±laÅŸtÄ±rÄ±lÄ±yor. EÅŸleÅŸmeyen veya metadata taÅŸÄ±mayan eventler `unmatched_channel` durumunda durable olarak tutuluyor ve worker tarafÄ±ndan conversation/message olarak iÅŸlenmiyor.
- Outbound reaction provider, API endpoint'i, worker delivery branch'i ve Inbox hedef mesaj rozeti tamamlandÄ±; reaction kaldÄ±rma boÅŸ emoji ile destekleniyor.
- Media MIME codec parametreleri (`audio/ogg; codecs=opus`) normalize edilerek gerçek WhatsApp voice dosyalarÄ±nÄ±n reddedilmesi giderildi.
- Production worker, API ile aynÄ± production configuration fail-fast kontrolünü uyguluyor.
- `pnpm test`, `pnpm typecheck`, `pnpm build` ve `pnpm lint` baÅŸarÄ±lÄ±; lint'te yalnÄ±zca Next.js `<img>` optimizasyon uyarÄ±sÄ± kaldÄ±.
### Inbox parity slice

- The channel preference now uses the URL `channel` parameter as source of truth; localStorage is only a fallback.
- Conversation list pagination now exposes the opaque cursor and appends the next page without duplicate rows.
- `assigned_to_me`, `unassigned`, unread and status filters are sent as server-side query parameters.
- SSE-connected Inbox instances stop the three-second polling loop; polling remains a reconnect/offline fallback and SSE open triggers reconciliation.

### Faz 1 uygulaması

- Sohbet açıldığında Inbox artık `POST /api/v1/conversations/:id/read` çağırıyor ve yerel unread sayısını sıfırlıyor.
- API, son inbound Meta mesajının provider ID'sini bulup Meta `/messages` endpoint'ine `status=read` gönderiyor.
- Provider read receipt başarısız olursa sohbet yüklenmeye devam ediyor; sonraki reconciliation tekrar deniyor.

### Faz 2-4 uygulaması

- Quoted reply için outbound `replyToMessageId` API metadata'sı ve Meta `context.message_id` gönderimi eklendi.
- Inbound Meta `context.id` normalize edilerek Inbox'ta alıntı kartı gösteriliyor.
- Konum, kişi ve interactive inbound mesaj tipleri için ayrı Inbox kartları eklendi.
- Chat mesajları cursor ile geriye doğru sayfalanabiliyor; scroll konumu korunuyor.

### Canlı Meta trafik incelemesi — 2026-07-18

- `Hasan Yıldırım` / `+90 530 744 08 94` kanalı (`phone_number_id` sonu `9402`) gerçek Meta webhook'larını `processed` olarak almış; inbound text/audio/video kayıtları ve outbound `delivered` mesajı veritabanında mevcut.
- `+1 (555) 638-2014` kanalı (`phone_number_id` sonu `3444`) `CHANNEL_AUTH_FAILED` durumunda ve son başarılı mesaj zamanı yok. Bu kanalın sorunu Inbox UI değil, Meta credential/token yetkilendirmesidir.
- Son test payload'larının bir bölümü fake/integration payload'ı olup `unmatched_channel` olarak karantinaya alınmış; worker bunları konuşmaya çevirmiyor.
- Interactive outbound mesajlar normal text akışıyla aynı CRM timeline, usage metering ve realtime publish adımlarına bağlandı.
- API/Worker/Web image'ları tam Docker build ile üretildi ve force-recreate sonrası üç servis healthy; API `/health`, `/health/ready` ve Web `/app/inbox` 200 döndü.
- Typing indicator için Meta Cloud API'de bu uygulamanın kullandığı gönderim sözleşmesinde desteklenen bir provider işlemi bulunmadığından sahte bir sinyal eklenmedi; bu madde `unsupported_by_provider` olarak sınıflandırıldı.
