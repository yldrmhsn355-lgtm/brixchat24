# Brixchat24 Inbox / WhatsApp Cloud API Audit

Tarih: 2026-07-18
Kapsam: `C:\Users\pc\Documents\wazzup2` repository'si, Inbox ve Meta WhatsApp Cloud API akışları.
Yöntem: Kaynak, migration, test, çalışan Docker servisleri ve mevcut acceptance artefact'ları birlikte incelendi. Bu görev sırasında uygulama kodu, migration, component, endpoint veya production ayarı değiştirilmedi; yalnızca bu audit raporu oluşturuldu.

Durum etiketleri yalnızca istenen sözlükten kullanılmıştır: `VERIFIED`, `PARTIALLY_IMPLEMENTED`, `UI_ONLY`, `BACKEND_ONLY`, `MISSING`, `BROKEN`, `REGRESSED`, `INSECURE`, `EXTERNAL_ACCEPTANCE_REQUIRED`, `NOT_APPLICABLE`.

## Yönetici Özeti

Brixchat24; Next.js web, Fastify API, PostgreSQL, Redis/SSE, ayrı worker, transactional outbox ve resmi Meta Cloud provider ayrımına sahip çalışan bir monorepo'dur. HMAC imza doğrulaması, raw-body koruması, webhook deduplication, tenant filtresi, outbox transaction'ı, client-message idempotency, Meta status monotonicity, 24 saat penceresi ve signed-media URL akışlarının önemli bölümü kaynak ve testlerle doğrulanmıştır.

Bununla birlikte production veya çoklu kanal güvenlik kararı için kritik bir açık vardır: Inbox conversation/message/media/template sorguları agent'ın kanal sahipliğini değil yalnızca tenant ve assignment durumunu kontrol ediyor. Agent, başka kullanıcıya ait kanaldaki `unassigned` konuşmayı URL/API üzerinden okuyabilir ve bu konuşmadan gönderim başlatabilir. Ayrıca inbound reaction normal inbound gibi unread ve last-message güncellemesi yapıyor; production worker gerçekte local object storage ve `NoopMalwareScanner` kuruyor; upload endpoint'i dosyayı taramadan `scan_status='clean'` yazıyor. Bu bulgular P0/P1 seviyesindedir.

Mevcut local Docker runtime healthy olsa da `health/configuration` development için `valid:false` dönüyor; Meta, S3/R2 ve ClamAV acceptance raporları credential olmadan `pending_external_acceptance`. E2E suite 8 senaryonun 5'ini geçip 3'ünü timeout/fixture-state nedeniyle kaybetti. Sonuç: **NOT RELEASABLE**.

## Genel Mimari ve Dosya Haritası

| Alan                                   | Dosya karşılığı                                                                                                             | Durum                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Next.js web / Inbox                    | `apps/web/app/app/inbox/workspace.tsx`, `apps/web/app/app/inbox/page.tsx`                                                   | PARTIALLY_IMPLEMENTED       |
| Fastify composition                    | `apps/api/src/app.ts`                                                                                                       | VERIFIED                    |
| PostgreSQL/Drizzle schema ve migration | `packages/database/src/schema.ts`, `packages/database/migrations/0000..0009`                                                | PARTIALLY_IMPLEMENTED       |
| Repository/database katmanı            | `packages/database/src/repositories/index.ts`, `worker.ts`                                                                  | PARTIALLY_IMPLEMENTED       |
| Redis ve realtime                      | `apps/api/src/app.ts:260-275,712-795`, Inbox `:647-710`                                                                     | PARTIALLY_IMPLEMENTED       |
| Worker/queue                           | `apps/worker/src/index.ts`, `packages/database/src/repositories/worker.ts`                                                  | VERIFIED                    |
| Transactional outbox                   | `packages/database/src/repositories/index.ts:219-279`, `worker.ts:98-119`                                                   | VERIFIED                    |
| Meta Cloud provider                    | `packages/integrations/src/meta-whatsapp/provider.ts`, `messaging/provider-factory.ts`                                      | PARTIALLY_IMPLEMENTED       |
| Fake provider                          | `packages/integrations/src/fake/provider.ts`                                                                                | VERIFIED (development only) |
| Webhook GET/POST                       | `apps/api/src/app.ts:824-913`                                                                                               | PARTIALLY_IMPLEMENTED       |
| Webhook signature/raw body             | `apps/api/src/app.ts:164-175,854-864`, `packages/integrations/src/messaging/utils.ts:22-28`                                 | VERIFIED                    |
| Auth/session/RBAC                      | `apps/api/src/auth-routes.ts`, `packages/auth/src/index.ts`                                                                 | PARTIALLY_IMPLEMENTED       |
| Media pipeline                         | `apps/api/src/milestone5-routes.ts:218-385`, `apps/worker/src/index.ts:498-614`, `packages/integrations/src/media/index.ts` | INSECURE                    |
| Docker/deployment                      | `docker-compose.yml`, `docker-compose.production.yml`, `deploy/caddy/Caddyfile`                                             | PARTIALLY_IMPLEMENTED       |
| Test suites                            | `apps/*/src/*.test.ts`, `e2e/*.spec.ts`, `scripts/*`                                                                        | PARTIALLY_IMPLEMENTED       |

Precise unofficial WhatsApp/Web stack taraması: `apps`, `packages`, `scripts` altında Baileys, `whatsapp-web.js`, QR session, linked device, `getChats`, `remoteJid`, LID/JID veya browser session üretim kodu bulunmadı. Bu nedenle production provider sınırı resmi Meta Cloud yönünde korunuyor.

## Özellik Doğrulama Matrisi

| Özellik                                  | Durum                 | Beklenen davranış / tespit / kanıt                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sol navigasyon ve Inbox shell            | PARTIALLY_IMPLEMENTED | Navigasyon çalışıyor; workspace adı `apps/web/components/app-frame.tsx:74` ve Inbox `workspace.tsx:1134-1140` içinde hardcoded (`Brix Dental Group`). Mobil sidebar ve menü aksiyonları için kanıtlı E2E yok.                            |
| Global arama                             | PARTIALLY_IMPLEMENTED | Debounce ve sonuç açma var (`apps/web/components/global-search.tsx:31-48`); around-message API ayrı olsa da arama sonucundan hedef mesaja scroll davranışı Inbox'ta uygulanmıyor.                                                        |
| Conversation listesi                     | PARTIALLY_IMPLEMENTED | Cursor (`packages/database/src/repositories/index.ts:83-98`), avatar/telefon/kanal/unread var; satırda etiketler, pin/mute/archive, provider status ve assignee görünürlüğü eksik (`workspace.tsx:1320-1367`). Virtualization yok.       |
| Inbox filtreleri                         | PARTIALLY_IMPLEMENTED | All/assigned/unassigned/unread/archive/label query'leri var (`workspace.tsx:278`, `1195-1288`); waiting/closed/snoozed/saved views ve server facet counts yok. Sayaçlar yalnızca aktif listenin `conversations.length` değeridir.        |
| Etiket CRUD/filtre                       | PARTIALLY_IMPLEMENTED | CRUD ve tenant koşulları var (`conversation-ops-routes.ts:269-363`), single-label replacement route mevcut; UI'da edit/delete/hover menüsü ve uzun isim/scroll davranışına dair kanıt yok.                                               |
| Conversation header/operations           | PARTIALLY_IMPLEMENTED | Status, pin, mute, archive/read operasyonları backend'e bağlı (`conversation-ops-routes.ts`); channel health gerçek health_status yerine çoğunlukla `status` üzerinden gösteriliyor (`app.ts:807-814`, `347-386`).                       |
| Mesaj metni/status                       | PARTIALLY_IMPLEMENTED | Text, optimistic outbound, sent/delivered/read/failed ve retry altyapısı var; status event mesajdan önce gelirse kayboluyor (`worker.ts:260-262`).                                                                                       |
| Interactive/template/reply               | PARTIALLY_IMPLEMENTED | Provider ve outbox dalları var (`worker/index.ts:179-209`); inbound button/list reply ayrı normalize edilmediği için UI çoğu durumda genel interactive kartına düşüyor (`workspace.tsx:1566-1614`).                                      |
| Image/video/audio/voice/document/sticker | PARTIALLY_IMPLEMENTED | Inbound attachment job ve image/video/audio preview var; document için yalnızca generic paperclip, upload taraması bypass ediyor (`milestone5-routes.ts:360-380`).                                                                       |
| Reaction                                 | BROKEN                | Provider ve UI rozeti mevcut (`app.ts:608-632`, `workspace.tsx:1762-1779`), fakat inbound reaction da unread ve last message artırıyor (`worker.ts:291-301,212-223`).                                                                    |
| Composer/window                          | PARTIALLY_IMPLEMENTED | Free text backend'de 24 saat dışında reddediliyor (`repositories/index.ts:243-253`), template endpoint approved/language/variable doğruluyor (`product-routes.ts:648-697`). Drag/drop, upload progress ve duplicate-click UI kanıtı yok. |
| Channel selector                         | PARTIALLY_IMPLEMENTED | Internal `channel.id`, URL `channel` ve localStorage fallback kullanılıyor (`workspace.tsx:181-191,316-354`); agent ownership filtreleri yalnızca accounts endpoint'inde, conversation/message sorgularında enforce edilmiyor.           |
| Inbound webhook                          | PARTIALLY_IMPLEMENTED | GET challenge, HMAC, raw body, multi-entry/change ve dedup ledger var (`app.ts:824-913`); explicit event classification/diagnostics/quarantine ekranı yok, unmatched yalnızca `unmatched_channel` status ile bırakılıyor.                |
| Outbound routing                         | PARTIALLY_IMPLEMENTED | DB conversation channel'ı kilitlenip `phone_number_id` worker context'e taşınıyor (`repositories/index.ts:235-257`, `worker/index.ts:141-149`); agent kanal sahipliği açığı nedeniyle yanlış channel üzerinden erişim/gönderim mümkün.   |
| Delivery status                          | PARTIALLY_IMPLEMENTED | Rank ve failed terminal davranışı var (`worker.ts:263-297`); status-before-message pending reconciliation yok, conversation list status eventlerinde gereksiz refresh olabilir.                                                          |
| SSE/realtime                             | PARTIALLY_IMPLEMENTED | 60 saniyelik realtime token ve SSE RBAC var (`app.ts:713-795`), reconnect ve polling fallback var (`workspace.tsx:647-710`); Last-Event-ID/version, bounded dedup ve reconnect sonrası event replay yok.                                 |
| Auth/session                             | INSECURE              | Refresh token HttpOnly cookie ve rotation mevcut (`auth-routes.ts:60-68,292-316`); access token localStorage'da tutuluyor (`apps/web/lib/api.ts:4-10`) ve XSS etkisini büyütüyor.                                                        |
| Tenant/RBAC                              | BROKEN                | Tenant koşulları var fakat agent channel ownership conversation/message/media/template zincirinde yok (`repositories/index.ts:88-90`, `milestone5-routes.ts:337-341`, `product-routes.ts:651`).                                          |
| Production storage/scanner               | INSECURE              | API/worker runtime doğrudan `LocalObjectStorageProvider` ve `NoopMalwareScanner` kuruyor (`app.ts:293-306`, `worker/index.ts:76-81`); production validator sadece env'i kontrol ediyor.                                                  |
| Docker/health                            | PARTIALLY_IMPLEMENTED | Local servisler healthy; production compose image/secrets/read-only edge tanımlıyor. Readiness object storage'ı kontrol ediyor ama gerçek S3/ClamAV adapter wiring'i yok (`milestone5-routes.ts:615-625`).                               |

## P0 Problemler

### P0-1 — Agent channel ownership bypass

- **Durum:** INSECURE
- **Özellik:** Çoklu WhatsApp channel erişimi, Inbox conversation/message/template/media.
- **Beklenen davranış:** Agent yalnızca `channel_user_ownership` ile yetkili olduğu channel'ın konuşmalarını okuyabilmeli ve o channel üzerinden gönderim yapabilmeli.
- **Tespit:** `ConversationRepository.list` yalnızca tenant, assignment ve rol filtresi uyguluyor; `channelId` için ownership predicate yok (`packages/database/src/repositories/index.ts:88-90`). `conversations.get` aynı sorguyu kullanıyor (`:100-113`). Upload conversation sorgusu da yalnızca organization koşulu taşıyor (`apps/api/src/milestone5-routes.ts:337-341`).
- **Kullanıcı etkisi:** Yetkisiz agent URL/API ile başka numaranın unassigned konuşmasını görebilir, media yükleyebilir veya template/free-text gönderimi başlatabilir.
- **Teknik risk:** Cross-channel veri ifşası ve yanlış WhatsApp numarasından mesaj gönderme.
- **Önerilen çözüm:** Tek bir `canAccessConversationChannel` repository/policy fonksiyonu; list/get/message/send/template/upload/attachment/search/SSE event filtrelerinin tamamında aynı predicate; cross-channel negatif test.
- **Kabul kriteri:** Agent A'nın sahibi olmadığı Channel B'deki unassigned conversation için list/get/messages/template/media/send isteklerinin tamamı 404/403 döner; owner/admin akışı etkilenmez.

## P1 Problemler

### P1-1 — Inbound reaction unread ve last-message semantiğini bozuyor

- **Durum:** BROKEN
- **Kanıt:** Worker tüm `value.messages` kayıtlarında `unread_count=unread_count+1`, `last_message_id`, `last_message_at` ve service window güncellemesi yapıyor (`packages/database/src/repositories/worker.ts:291-301,210-223`). Reaction sadece text body yerine emoji ile ayrıştırılıyor (`apps/worker/src/index.ts:295-301`), fakat özel dal yok.
- **Etkisi/risk:** Reaction, gerçek müşteri mesajı gibi unread üretir ve konuşmayı listenin üstüne taşır; hedef mesajın son mesaj özetini bozar.
- **Çözüm/kabul:** Reaction için ayrı persistence/event dalı; unread=0, conversation summary değişmez, hedef `message_id` üzerinde badge oluşur. Duplicate reaction replay tek kayıt olmalı.

### P1-2 — Production media security adapter'ları runtime'a bağlı değil

- **Durum:** INSECURE
- **Kanıt:** API `LocalObjectStorageProvider` kuruyor (`apps/api/src/app.ts:293-306`), worker da aynı şekilde local provider ve `NoopMalwareScanner` kuruyor (`apps/worker/src/index.ts:76-81`). Upload endpoint dosyayı doğrudan saklayıp `processing_status='stored', scan_status='clean'` yazıyor (`apps/api/src/milestone5-routes.ts:360-380`); magic-byte/malware doğrulaması yok. Gerçek scanner yalnız inbound worker download dalında çağrılıyor (`apps/worker/src/index.ts:527-550`).
- **Etkisi/risk:** Zararlı outbound dosya “clean” olarak gönderilebilir; local disk production failover/tenant isolation ve retention garantisi vermez.
- **Çözüm/kabul:** Provider factory S3/R2 ve ClamAV'ı env'e göre kurmalı; upload da pending→scan→stored akışına girmeli; MIME ile magic-byte eşleşmeli; production'da local/noop startup fatal olmalı. EICAR ve yanlış MIME testleri reddedilmeli.

### P1-3 — Agent kanal izolasyon açığı gönderim yüzeylerine yayılıyor

- **Durum:** INSECURE
- **Kanıt:** `createOutbound` yalnız conversation organization/channel status/window kontrolü yapıyor (`packages/database/src/repositories/index.ts:235-257`); template route conversation/template channel eşleşmesini kontrol etse de agent channel ownership kontrol etmiyor (`apps/api/src/product-routes.ts:648-689`).
- **Etkisi/risk:** P0-1'in doğrudan mesaj, template ve media send etkisi.
- **Çözüm/kabul:** Gönderim transaction'ı içinde user→channel ownership lock/predicate; yanlış channel id ile 403/404; provider çağrısından önce fail.

### P1-4 — Status-before-message event kayboluyor

- **Durum:** PARTIALLY_IMPLEMENTED
- **Kanıt:** `MessageStatusRepository.status` provider message bulunamazsa `null` dönüyor (`packages/database/src/repositories/worker.ts:257-262`); pending status tablosu veya sonradan reconciliation yok.
- **Etkisi/risk:** Meta out-of-order webhook'larında kullanıcı sent/delivered/read durumunu kalıcı kaybedebilir.
- **Çözüm/kabul:** Unknown status event durable pending ledger'a yazılmalı; message insert sonrası replay edilmeli; status rank geriye gitmemeli.

### P1-5 — Gerçek Meta acceptance yapılmamış

- **Durum:** EXTERNAL_ACCEPTANCE_REQUIRED
- **Kanıt:** `artifacts/acceptance/meta-acceptance-report.md` credential olmadan `pending_external_acceptance` ve “no external call was made” diyor. `scripts/external-acceptance.ts:7-34` yalnız env var varlığını kontrol ediyor; canlı gönderim/teslim kanıtı üretmiyor.
- **Etkisi/risk:** Gerçek inbound, outbound, media, template, status, read receipt ve yanlış phone_number_id negatif akışı kanıtlanmadı.
- **Çözüm/kabul:** Yetkili staging WABA ve harici test telefonu ile correlation ID'li text/media/template/status/read/duplicate/negative test raporu.

### P1-6 — E2E suite temel Inbox akışında kırmızı

- **Durum:** BROKEN
- **Kanıt:** `pnpm test:e2e` sonucu 8 testten 5 pass, 3 fail: `live-messaging` composer placeholder timeout; `milestone3` template count mismatch; `milestone5` media processing button timeout. Failure screenshot'ta selected conversation 24 saat penceresi kapalı ve composer disabled.
- **Etkisi/risk:** Regression gate güvenilir değil; canlı kabul öncesi UI/worker/media akışı kanıtlanamıyor.
- **Çözüm/kabul:** Her test bağımsız fixture/tenant/channel oluşturmalı, test sonunda cleanup yapmalı; 8/8 pass iki ardışık temiz çalıştırmada.

## P2 Problemler

### P2-1 — Realtime replay/version garantisi yok

- **Durum:** PARTIALLY_IMPLEMENTED
- **Kanıt:** SSE yalnız Redis pub/sub ve 15 saniye heartbeat kullanıyor (`apps/api/src/app.ts:763-795`); Last-Event-ID, durable event cursor veya entity version yok. Frontend `seen` Set'i sınırsız büyüyor (`workspace.tsx:696-703`).
- **Etkisi/risk:** Disconnect sırasında event kaybı/duplicate refresh; uzun oturumda client memory büyümesi.
- **Çözüm/kabul:** Bounded event cache + Last-Event-ID/reconciliation cursor + entity version; 24 saat soak testinde bounded memory ve duplicate event yok.

### P2-2 — Filtreler ve sayaçlar Inbox parity seviyesinde değil

- **Durum:** PARTIALLY_IMPLEMENTED
- **Kanıt:** UI yalnız 4 temel filtre ve archive/label gösteriyor (`workspace.tsx:1195-1288`); `waiting`, `closed`, `snoozed`, saved views ve facet count endpoint'i yok. Sayaçlar yalnız aktif `conversations.length` ile dolduruluyor (`:1213-1229`).
- **Etkisi/risk:** Operatör doğru kuyruk büyüklüğünü göremez; kanal değişince sayılar yanıltıcı olabilir.
- **Çözüm/kabul:** Server-side facet counts, status/saved-view filtreleri ve channel+scope kombinasyonları; her count bağımsız DB sorgusuyla doğrulanmalı.

### P2-3 — Conversation identity constraint aktif durumları tam korumuyor

- **Durum:** PARTIALLY_IMPLEMENTED
- **Kanıt:** Migration `UNIQUE(organization_id,channel_id,contact_id,status)` kuruyor (`packages/database/migrations/0001_live_messaging.sql:4-5`). Worker mevcut conversation aramasında `status IN ('open','waiting')` yapıyor (`packages/database/src/repositories/worker.ts:161-164`). Aynı contact için open ve waiting satırları aynı anda mümkün.
- **Etkisi/risk:** Aynı WhatsApp channel/customer için iki aktif conversation, yanlış summary ve duplicate assignment.
- **Çözüm/kabul:** Tek partial unique active identity veya transaction lock; concurrent inbound testinde tek aktif conversation.

### P2-4 — Medya outbound belleğe tamamen alınıyor

- **Durum:** PARTIALLY_IMPLEMENTED
- **Kanıt:** Worker `storage.getObject` stream'ini `chunks: Buffer[]` ile tamamen belleğe topluyor (`apps/worker/src/index.ts:151-163`).
- **Etkisi/risk:** 25 MB+ dosyalarda worker memory spike ve concurrent upload starvation.
- **Çözüm/kabul:** Provider upload için streaming/multipart adapter; sabit memory profilinde 10/25 MB concurrent load testi.

### P2-5 — Channel health gerçek health_status yerine connected status'a indirgenmiş

- **Durum:** PARTIALLY_IMPLEMENTED
- **Kanıt:** Accounts endpoint `status === 'connected' ? healthy : unhealthy` döndürüyor (`apps/api/src/app.ts:380-386`), health endpoint de `channel.status` alanını kullanıyor (`:807-814`). Ayrı health test route'u `health_status` yazsa da selector bu alanı göstermiyor (`apps/api/src/product-routes.ts:460-472`).
- **Etkisi/risk:** Token expired, webhook inactive, permission error gibi durumlar kullanıcıya healthy görünebilir.
- **Çözüm/kabul:** Taxonomy (`configuration_required`, `checking`, `healthy`, `degraded`, `token_expired`, `permission_error`, `webhook_not_verified`, `webhook_inactive`, `rate_limited`, `disabled`, `error`) persisted ve selector/header/channel card'da gösterilmeli.

### P2-6 — UI lint ve architecture gate kırmızı

- **Durum:** BROKEN
- **Kanıt:** `pnpm lint` web'de 3 error verdi (`workspace.tsx:248,312,356`) ve bir img warning'i bıraktı. `pnpm architecture:check` graph gate'i geçti fakat database boundary gate'i `apps/api/src/conversation-ops-routes.ts` direct SQL baseline'ının 24'ten 26'ya çıktığını bildirerek fail oldu.
- **Etkisi/risk:** CI/release gate güvenilmez; doğrudan SQL artışı repository sınırını aşındırıyor.
- **Çözüm/kabul:** React lint uyarıları temizlenmeli; label işlemleri repository'ye taşınmalı; architecture check exit code 0.

## P3 İyileştirmeler

### P3-1 — Workspace ve responsive erişilebilirlik

- **Durum:** PARTIALLY_IMPLEMENTED
- **Kanıt:** Workspace switcher ve yardım/bildirim düğmeleri görsel olarak var (`workspace.tsx:1134-1185`), fakat switcher/help/bell işlevsel akışa bağlı değil; mobile/tablet E2E matrisi yok.
- **Kabul:** 1440/1280/1024/768/390/360 viewport'larında yatay taşma yok, keyboard focus-visible ve Escape ile tüm popover'lar kapanıyor.

### P3-2 — Mesaj tipi fallback'leri

- **Durum:** PARTIALLY_IMPLEMENTED
- **Kanıt:** UI interactive/location/contact için kart üretirken diğer türleri `[type]` fallback'ine bırakıyor (`workspace.tsx:1566-1660`); document generic paperclip ve deleted/unsupported/system ayrı tasarıma sahip değil.
- **Kabul:** Her inbound Meta message type (text/image/video/audio/document/sticker/location/contact/reaction/interactive/button/list/template/unsupported/deleted) için ayrı fixture ve görünür state.

## UI/UX Eksikleri

- `Brix Dental Group` ve `Primary workspace` hardcoded (`apps/web/components/app-frame.tsx:74`, `workspace.tsx:1137-1138`); `/api/v1/auth/me` yalnız kullanıcı adı için çağrılıyor.
- Conversation satırı etiketleri, atanan kullanıcı, 24 saat penceresi, pin/mute/archive ve gerçek delivery status'u göstermiyor.
- `Yeni konuşma`, bildirim ve yardım düğmeleri işlevsiz görsel aksiyonlar.
- Etiket UI CRUD'unda edit/delete/hover menu, uzun isim ellipsis ve çok etiket scroll kanıtı yok.
- Sağ tık context menu var; keyboard context-menu eşdeğeri ve focus trap için test yok.
- Arama sonucu `messageId` URL'e yazılsa da Inbox bu parametreyi okuyup ilgili mesajı highlight/scroll etmiyor.

## Cloud API Eksikleri

- Production Meta credential varlığı canlı olarak doğrulanmadı; `artifacts/acceptance/meta-acceptance-report.md` external pending.
- Unknown `metadata.phone_number_id` durable `unmatched_channel` oluyor (`app.ts:890-907`) fakat ayrı quarantine diagnostics/query UI'si yok.
- Webhook bütün entry/change/message/status öğelerini worker'a bırakıyor; status-before-message pending ledger yok.
- Provider error normalizasyonu HTTP status seviyesinde; Meta error code/subcode/title/details payload'ı normalize edilip kullanıcıya güvenli kod olarak taşınmıyor (`meta-whatsapp/provider.ts:103-123`).
- Template list pagination var (`provider.ts:319-370`), ancak sync error/last sync görünürlüğü ve channel permission parity eksik.

## Backend ve Database Eksikleri

- Agent channel ownership predicate'i bütün conversation/message/template/media/search/SSE yollarına eklenmeli.
- Aktif conversation identity için partial unique constraint ve race test gerekli.
- Reaction/system/status event'leri için last-message/unread kuralları ayrıştırılmalı.
- Status event before message için pending status table/replay mekanizması gerekli.
- API route'larında doğrudan SQL baseline'ı aşıldı; repository sınırı yeniden kurulmalı.

## Realtime Eksikleri

- SSE token kısa ömürlü ve access token URL'e konulmuyor; bu kısım VERIFIED güvenlik kazanımıdır (`app.ts:716-725`).
- Buna karşın Last-Event-ID, durable replay, version ordering ve bounded client dedupe yok.
- Redis event payload'ları organization kanalına yayınlanıyor; agent conversation lookup ile filtreleniyor, fakat selected WhatsApp channel filtresi event seviyesinde yok; her event tam liste fetch'ine sebep oluyor.
- SSE kapalıyken 3 saniye polling fallback var (`workspace.tsx:647-660`); connected durumda duruyor, ancak görünmeyen sekme/backoff/visibility optimizasyonu yok.

## Medya Eksikleri

- Inbound: Meta media ID → metadata → authenticated download → MIME/magic byte → storage → scanner → thumbnail zincirinin çoğu worker'da var (`worker/index.ts:519-590`).
- Outbound upload: storage'a yazma sonrası scan yapılmadan clean işaretleniyor (`milestone5-routes.ts:360-380`); bu P1 güvenlik açığıdır.
- Production S3/R2 adapter sınıfı mevcut (`packages/integrations/src/media/index.ts:146-165`) fakat app/worker factory tarafından kurulmamış.
- Temporary Meta URL kalıcı saklanmıyor; signed URL endpoint tenant koşullu ve 5 dakikalık TTL ile çalışıyor (`milestone5-routes.ts:218-243`).
- Thumbnail `sharp` ile limitli; outbound provider upload ise tüm bytes'ı RAM'e topluyor.

## Güvenlik Eksikleri

- **P0:** Agent cross-channel access/send.
- **P1:** Access token localStorage (`apps/web/lib/api.ts:4-10`); HttpOnly yalnız refresh cookie için kullanılıyor.
- HMAC timing-safe/raw-body ve log redaction VERIFIED (`app.ts:148-160,164-175,854-864`).
- Tenant koşulları çoğu sorguda mevcut; ancak ownership policy merkezi olmadığı için tenant içi channel izolasyonu kırık.
- Signed media URL key path traversal'a karşı local provider `resolve` kontrolü yapıyor (`media/index.ts:59-64`); fakat production storage adapter wiring yok.
- Rate limit global 120/min ve login route limitleri var (`app.ts:222`, `auth-routes.ts:192-195`); endpoint bazlı abuse/attachment rate limit matrisi kanıtlanmadı.
- Raw webhook payload durable saklanıyor; retention/redaction/PII TTL'si bu auditte runtime kabulüyle doğrulanamadı.

## Production Eksikleri

- `validateProductionConfig` çok sayıda fatal kontrol içeriyor (`packages/integrations/src/secrets/index.ts:32-214`) ve API/worker startup production'da fail-fast yapıyor (`apps/api/src/server.ts:20-34`, `apps/worker/src/index.ts:54-64`). Bu olumlu guardrail'dir.
- Runtime provider wiring yine local/noop olduğu için validator ile uygulama davranışı arasında uyumsuzluk var.
- `docker-compose.yml` geliştirme secret'ları, localhost URL, local storage ve noop scanner içeriyor (`docker-compose.yml:31-54,76-88`); production compose ayrı image/secrets kullanıyor ama acceptance ile bağlanmıyor.
- Backup/restore, SBOM, secret scan ve release artefact'ları mevcut; `artifacts/release/release-gate.json` external acceptance blocked.
- Public HTTPS/Cloudflare ve gerçek object storage/ClamAV canlı olarak bu çalışma alanında doğrulanmadı.

## Test Eksikleri

Mevcut unit/API testleri HMAC, auth rotation, tenant, idempotency, fake provider, template validation ve basic health'i kapsıyor. Database/worker paketlerinde gerçek test dosyası yok veya `--passWithNoTests` ile geçiyor. Eksik senaryolar:

- cross-channel agent read/send negative test,
- reaction unread/summary invariant,
- status-before-message replay,
- unknown phone number quarantine diagnostics,
- media upload malware/magic-byte rejection,
- SSE reconnect/replay/Last-Event-ID/multi-tab,
- pagination/filter/channel-switch race,
- real Meta inbound/outbound/media/template/read/negative phone number.

## Hızlı Kazanımlar (1 günden kısa)

1. Agent channel ownership predicate'ini ortak policy/repository filtresine bağlamak ve negatif API testleri eklemek.
2. Reaction için unread/last-message güncellemesini durdurmak; targeted integration test eklemek.
3. Inbox filtrelerine waiting/closed/snoozed eklemek; sayaçları server facet endpoint'ine taşımak.
4. Hardcoded workspace adını `/api/v1/auth/me`/organization response ile değiştirmek.
5. E2E fixture'larında service window ve media fake provider state'ini test başına deterministik kurmak.
6. React lint hatalarını ve database architecture baseline artışını düzeltmek.

## Orta Vadeli Geliştirmeler (2–5 gün)

1. Status-before-message pending ledger/replay ve status event ordering testleri.
2. S3/R2 + ClamAV provider factory, outbound upload scan, MIME/magic-byte policy ve failure/retry UI.
3. Channel health taxonomy, webhook freshness, last error, token expiry ve template sync diagnostics.
4. Inbox row label/status/window/channel health parity; document/sticker/reply/button/list/deleted message cards.
5. SSE bounded replay, Last-Event-ID, entity version ve visibility-aware reconciliation.
6. Search `messageId` deep-link highlight/scroll ve server-side FTS/trigram planı.

## Büyük Mimari İşler (1 haftadan uzun)

1. Merkezi authorization policy ile conversation/channel/message/media/search/SSE kapsamının tüm endpoint'lerde tekleştirilmesi.
2. Outbox/provider delivery state machine'inin pending→queued→accepted→sent→delivered→read/failed modelleri ve provider error ledger ile yeniden tasarlanması.
3. Production media platformu: remote object storage, streaming multipart, ClamAV, thumbnail isolation, retention/PITR ve disaster recovery.
4. Event/realtime platformu: durable event log, replay cursor, multi-tab coordination, dedupe/version semantics ve load/soak acceptance.
5. Gerçek Meta staging acceptance pipeline'ı; credential injection, controlled phone, replay fixture ve release gate entegrasyonu.

## Öncelikli Uygulama Yol Haritası

### Aşama 1 — Veri bütünlüğü ve güvenlik

Channel ownership policy, agent negative tests, reaction invariants, active conversation constraint ve status-before-message ledger.

### Aşama 2 — Meta Cloud API parity

Unknown/test event classification, quarantine diagnostics, Meta error normalization, health taxonomy, template sync/error state ve gerçek acceptance fixture'ları.

### Aşama 3 — Inbox operasyonları

Facet counts, status/saved views, label row rendering, assignment/read/archive/pin/mute consistency, search deep-link ve pagination race testleri.

### Aşama 4 — UI ve kullanıcı deneyimi

Responsive six-viewport pass, keyboard/focus/ARIA audit, hardcoded workspace removal, message type cards, upload progress/retry ve composer polish.

### Aşama 5 — Production acceptance

S3/R2 + ClamAV wiring, public HTTPS/Cloudflare, backup/PITR restore proof, Meta text/media/template/status/read/negative tests, E2E 8/8 ve release gate.

## Kabul Testleri

| Öneri                 | Ölçülebilir kabul kriteri                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Channel authorization | Agent A, Channel B unassigned konuşma için list/get/message/template/media/send yollarında 403/404; owner/admin başarılı.                                    |
| Reaction invariant    | Inbound reaction sonrası unread ve conversation `last_message_id/last_message_at` değişmez; targeted message badge tekil kalır.                              |
| Status replay         | Status-before-message ve duplicate replay testlerinde final status doğru rank'e ulaşır, event kaybı/duplicate yoktur.                                        |
| Media security        | EICAR/yanlış magic-byte upload'ı stored/clean olamaz; production config S3+ClamAV olmadan startup/readiness fail eder.                                       |
| Health                | Token expired/webhook inactive/permission error ayrı status/code ve timestamp ile UI/API'de görünür.                                                         |
| Inbox filters         | Her filtre count'u server DB facet ile eşleşir; channel değişiminde eski cursor/list sonucu kalmaz.                                                          |
| Realtime              | Disconnect sırasında Last-Event-ID ile replay; duplicate event tek görünür; 24 saat soak memory bounded.                                                     |
| Responsive/a11y       | Altı viewport'ta yatay overflow yok; keyboard tab/focus/Escape ve ARIA assertions geçer.                                                                     |
| External Meta         | Gerçek WABA'da inbound/outbound text, delivered/read, media, template, duplicate replay ve wrong-phone negative kanıtı kayıtlı.                              |
| Release               | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`, `pnpm architecture:check`, Docker health ve acceptance artefact'ları tamamı pass. |

## İncelenen Dosyalar

- `apps/api/src/app.ts`, `auth-routes.ts`, `product-routes.ts`, `milestone5-routes.ts`, `milestone6-routes.ts`
- `apps/worker/src/index.ts`
- `apps/web/app/app/inbox/workspace.tsx`, `apps/web/lib/api.ts`, `apps/web/components/app-frame.tsx`, `global-search.tsx`
- `packages/database/src/schema.ts`, `repositories/index.ts`, `repositories/worker.ts`, migrations `0000..0009`
- `packages/integrations/src/meta-whatsapp/provider.ts`, `messaging/utils.ts`, `messaging/provider-factory.ts`, `media/index.ts`, `fake/provider.ts`, `secrets/index.ts`
- `packages/auth/src/index.ts`
- `docker-compose.yml`, `docker-compose.production.yml`, `deploy/caddy/Caddyfile`
- `e2e/*.spec.ts`, `apps/api/src/app.test.ts`, package tests
- `scripts/external-acceptance.ts`, `scripts/release-gate.ts`, `scripts/migration-safety.ts`
- `artifacts/acceptance/*`, `artifacts/release/release-gate.json`, `artifacts/security/*`

## Çalıştırılan Komutlar

| Komut                                                                                        | Sonuç                                                                                                           |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `python C:\Users\pc\.codex\skills\codebase-onboarding\scripts\codebase_analyzer.py . --json` | PASS; 2,121 dosya, TypeScript/SQL ağırlıklı monorepo.                                                           |
| `graphify query "Inbox WhatsApp Cloud API webhook realtime channels media security"`         | PASS; 203 düğümlü scoped architecture graph.                                                                    |
| `pnpm install --frozen-lockfile`                                                             | PASS.                                                                                                           |
| `pnpm typecheck`                                                                             | PASS; 11/11 task.                                                                                               |
| `pnpm lint`                                                                                  | FAIL; web `workspace.tsx:248,312,356` React Compiler/set-state errors, one `<img>` warning.                     |
| `pnpm test`                                                                                  | PASS; 18/18 task, API 25, integrations 34, auth 5, web 3 test passed; bazı paketler no-test ile geçti.          |
| `pnpm build`                                                                                 | PASS; 11/11 task.                                                                                               |
| `pnpm architecture:check`                                                                    | FAIL; graph check pass, database boundary baseline 24→26 direct SQL nedeniyle fail.                             |
| `pnpm db:migrate:check`                                                                      | PASS (çıktı üretmeden tamamlandı).                                                                              |
| `pnpm test:e2e`                                                                              | FAIL; 8 testten 5 pass, 3 fail (live composer, template count, media processing).                               |
| `docker compose ps`                                                                          | PASS; postgres, redis, api, web, worker healthy.                                                                |
| `GET http://localhost:3300/app/inbox`                                                        | 200.                                                                                                            |
| `GET http://localhost:4400/health`                                                           | 200.                                                                                                            |
| `GET http://localhost:4400/health/ready`                                                     | 200; PostgreSQL ve local object storage healthy.                                                                |
| `GET http://localhost:4400/health/configuration`                                             | 200 fakat development config `valid:false`; local/default secret, local storage/noop scanner kontrolleri fatal. |
| `GET http://localhost:4400/health/dependencies`                                              | 401 (operations permission olmadan beklenen).                                                                   |
| `GET http://localhost:4400/metrics`                                                          | 403 (metrics key olmadan beklenen).                                                                             |
| Production stack keyword scan                                                                | PASS; unofficial WhatsApp/Web stack production kodunda eşleşme yok.                                             |

`pnpm db:migrate` ve `pnpm db:seed` bu salt audit görevinde veri değiştirmemek için çalıştırılmadı. Canlı Meta acceptance komutları credential/test telefonu olmadan harici çağrı yapmayacak şekilde pending'dir.

## Test Sonuçları

- Local runtime temel health: PASS.
- Static type/build: PASS.
- Unit/API testleri: PASS.
- Lint: FAIL.
- Architecture boundary: FAIL.
- E2E: FAIL (5/8).
- Meta/S3/ClamAV gerçek external acceptance: EXTERNAL_ACCEPTANCE_REQUIRED; mevcut artefact'lar “no external call was made” diyor.
- Production configuration: development runtime healthy olsa da production parity kanıtlanmadı; local/noop adapter wiring riski açık.

## Nihai Karar

**NOT RELEASABLE**

P0 channel ownership açığı, P1 reaction/media/status riskleri, kırmızı lint/architecture/E2E kapıları ve gerçek Meta/object-storage/malware acceptance kanıtının olmaması giderilmeden sistem production'a çıkarılmamalıdır.
