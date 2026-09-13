# Kanallar: Cloud API + WhatsApp Web yeniden geliştirme planı

## Karar özeti

`/app/channels`, kanalın görünen platformunu bağlantı yönteminden ayıracak:

- Platform: `whatsapp`, `instagram`, `messenger`, `telegram`, `sms`, `email`, `web_chat`
- Provider adapter: `meta_whatsapp_cloud`, `whatsapp_web_baileys` ve gelecekte eklenecek bağımsız adapterlar
- Provider account: Cloud API erişim anahtarının/WABA hesabının güvenli yaşam döngüsü
- Channel: inbox, conversation ve mesajların bağlı olduğu iş birimi
- Runtime session: yalnız WhatsApp Web bağlantısının QR, Signal anahtarları, lease ve reconnect durumu

Cloud API ve WhatsApp Web aynı adapter içinde koşullu çalışmayacaktır. Ortak katman yalnız normalize mesaj/event sözleşmeleri, canonical conversation/contact yazımı, outbox sonucu ve realtime event zarfıdır.

## 1. Mevcut kanal veri modeli

`channels` tenant sahibi kanal kaydıdır. `provider`, `platform`, `provider_account_id`, dış kimlikler, connection/health durumu, capability listesi, şifreli credential referansı ve son inbound/outbound/webhook alanlarını taşır. `provider_accounts` bir organization içindeki ortak provider hesabını ve AES-256-GCM şifreli credential verisini tutar. `channel_user_ownership` kanal görünürlüğü ve sahipliğini sınırlar. Soft delete `deleted_at` ile uygulanır; conversation/message geçmişi korunur.

Model provider-neutral olmaya başlamış olsa da `phone_number_id`, `business_account_id`, `last_webhook_at` ve Cloud API odaklı health alanları hâlâ channel üzerinde legacy kolaylık alanlarıdır. Bunlar kaldırılmayacak; provider-specific `identity` ve `configuration` nesneleriyle birlikte geçiş döneminde kullanılacaktır.

## 2. WhatsApp Cloud API akışı

Cloud kanal oluşturma `POST /api/v1/channels` üzerinden Meta kimliklerini ve access tokenı doğrular, provider account oluşturur/günceller, credentialı şifreler, kanal sahipliğini yazar ve WABA webhook aboneliğini Meta Graph API üzerinden kurar. Webhook `/webhooks/meta/whatsapp/:publicId` tarafından imza/verify-token kontrollerinden sonra durable `provider_webhook_events` kuyruğuna alınır. Worker eventleri normalize eder, contact/conversation/message canonicalization yapar ve Redis realtime event yayınlar. Outbound mesajlar transactional `outbox_jobs` üzerinden Cloud adapterına gönderilir.

## 3. WhatsApp Web akışı

LIVE kaynak ağacında çalışan WhatsApp Web runtime yoktur. Aynı repository geçmişindeki adapter `@whiskeysockets/baileys` kullanır ve ayrı engine, auth-state, session manager, event bus, message/media/status mapper sınırlarına sahiptir. Bu sınırlar korunarak mevcut PostgreSQL/Redis worker mimarisine taşınacaktır.

Hedef akış: kanal oluşturma -> boş ve şifreli session kaydı -> worker lease -> Baileys socket -> kısa ömürlü QR -> `connected` -> inbound event normalization -> ortak canonicalization. Outbound outbox, provider anahtarına göre ayrı WhatsApp Web dispatcherına yönlenecektir.

## 4. Kullanılan WhatsApp Web kütüphanesi

Doğrulanan mevcut proje adapterı `@whiskeysockets/baileys` `6.7.18` kullanır. `whatsapp-web.js`, Puppeteer veya ikinci bir WhatsApp Web kütüphanesi eklenmeyecektir.

## 5. QR, session ve reconnect davranışı

Tarihsel adapter QR üretme, connection update, logout, auth credential güncelleme ve Signal key batch yazımını destekler. LIVE uyarlamasında:

- QR ham değeri loglanmayacak ve response cache kapatılacaktır.
- QR yalnız kısa TTL boyunca, uygulama anahtarıyla şifreli saklanacaktır.
- Baileys `creds` ile tüm Signal key tipleri ayrı ve şifreli saklanacaktır.
- Tek session için tek worker/socket, veritabanı lease ile garanti edilecektir.
- Reconnect exponential backoff ve terminal logout ayrımıyla yapılacaktır.
- QR görünmesi başarı sayılmayacaktır; restart persistence ve benzersiz inbound mesaj kabul testinin ayrı kanıtı gerekir.

## 6. Inbound ve outbound akışı

Cloud inbound akışı webhook tabanlıdır; WhatsApp Web inbound akışı Baileys socket event tabanlıdır. İkisi ortak bir normalize event sözleşmesinden sonra aynı tenant-safe contact/conversation/message yazımına ulaşır.

Outbound, mevcut transactional outbox üzerinden provider anahtarına göre dispatch edilir. Cloud adapter HTTP/Graph API kullanır; Web adapter aktif Baileys sessionı kullanır. Retryability ve provider hata kodları ortak hata zarfına çevrilir, fakat provider-specific reconnect ve rate-limit kararları kendi adapterında kalır.

## 7. Kanal ve conversation ilişkisi

`conversations.channel_id` zorunludur ve `messages.channel_id` provider bağımsız kanal filtresini taşır. Aynı contact farklı kanallarda ayrı aktif conversation kimliği oluşturabilir. Kanal arşivlendiğinde geçmiş conversation/message kayıtları silinmez.

## 8. Inbox kanal filtresi

Inbox repository’si halihazırda `channelId` filtresi, kanal sahipliği ve tenant kısıtı uygular. Yeni platform/provider alanları yalnız kanal seçicisinin etiketlerini zenginleştirecek; canonical conversation anahtarı veya mevcut RBAC kapsamı değişmeyecektir.

## 9. Credential ve session güvenliği

Cloud access token/app secret `APP_ENCRYPTION_KEY` ile AES-256-GCM şifrelenir ve API yanıtlarına dönmez. WhatsApp Web session verisi Cloud credential tablosuna konmayacaktır. Ayrı session ve Signal key tablolarında her değer uygulama katmanında şifreli tutulacak, QR TTL sonunda temizlenecek, logout/delete yalnız ilgili session/auth verisini temizleyecektir. Audit kayıtlarında token, QR, creds veya key materyali bulunmayacaktır.

## 10. Realtime yapısı

API ve worker Redis `brixchat:<organizationId>` kanalına versioned event zarfı yayınlar; web SSE/realtime katmanı bunu tüketir. Channel lifecycle için `channel.created`, `channel.updated`, `channel.health_changed`; WhatsApp Web için ayrıca `channel.session_state_changed` ve `channel.qr_updated` kullanılacaktır. QR event payloadı ham secret taşımayacak, istemci yetkili status endpointini çağıracaktır.

## 11. Provider-specific bağımlılıklar

- Cloud: Meta Graph API, webhook signature/verify token, WABA/phone-number kimlikleri, template management.
- Web: Baileys socket, Signal auth store, QR/linked-device state, worker lease ve persistent reconnect.
- Ortak: normalized message/event, object storage ve malware scan, outbox, contact/conversation canonicalization, Redis realtime, audit/RBAC.

Template yönetimi yalnız Cloud capability’sidir. WhatsApp Web, resmî Cloud API veya Meta Business Platform garantisi sunuyormuş gibi gösterilmeyecektir.

## 12. Kopuk frontend/backend bağlantıları

Mevcut sayfa provider kataloğunu ve CRUD/health/template/webhook endpointlerini kullanır; ancak referans tasarımdaki arama, durum/sağlık filtresi, liste/grid modu, ekip özeti ve açık conversation metrikleri yoktur. Cloud-only form alanları bütün providerlar için render edilir. Provider etiketi ile platform etiketi görsel olarak ayrılmamıştır. WhatsApp Web session/QR/reconnect endpointleri LIVE dalında yoktur.

## 13. Migration ihtiyacı

Yeni migration:

- Provider enum yerine text tabanlı katalog uyumluluğunu korur.
- `whatsapp_web_sessions`: tenant/channel, encrypted creds/QR, state, lease, heartbeat, retry ve hata alanları.
- `whatsapp_web_signal_keys`: tenant/channel/key-type/key-id ve şifreli değer.
- Aktif session ve lease taramaları için partial indexler.
- Organization ve channel FK’leriyle tenant bütünlüğü.

Production migration, doğrulanmış backup/restore kanıtı olmadan uygulanmayacaktır.

## 14. Değiştirilecek dosya grupları

- `packages/integrations/src/messaging/*`: provider katalog kimliği ve ortak sözleşmeler
- ayrı WhatsApp Web connector paketi: Baileys engine/auth/session/event katmanları
- `packages/database/src/schema.ts`, repository’ler ve yeni migration
- `apps/api/src/product-routes.ts`: provider-aware CRUD, list metrics ve Web session lifecycle
- `apps/worker/src/index.ts`: provider dispatch ve Web runtime ownership
- `apps/web/app/app/channels/*`: referans ekran, filtreler, provider seçimi, QR/risk akışı
- `apps/web/app/globals.css`: responsive liste/grid görünümü
- testler, environment örneği, runbook ve adapter rehberi

## 15. Test ve kabul kriterleri

- Provider kataloğu Cloud ve Web’i ayrı, gelecekteki adapterları disabled `Yakında` döndürür.
- Cloud create/delete/send/webhook regression testleri geçer.
- Web create -> QR -> connected -> restart persistence -> unique inbound -> outbound -> logout/delete zinciri gerçek session ile kanıtlanır.
- Exact Baileys auth key-type sayımları restart öncesi/sonrası raporlanır.
- Aynı channel için birden fazla canlı worker/socket oluşmaz.
- Credential, QR ve Signal key API/log/audit içinde açığa çıkmaz.
- Kanal listesi gerçek ekip/conversation/event metriklerini gösterir; arama, durum, sağlık, platform ve görünüm filtresi çalışır.
- Agent/team lead tenant ve ownership sınırını aşamaz.
- Lint, typecheck, unit/integration, build, migration safety ve Playwright görsel kabul geçer.
- Production deploy yalnız backup kanıtı, migration gate ve gerçek dış kabul sonuçları ayrı ayrı GO ise yapılır.

## 16. Fazlara ayrılmış uygulama planı

1. Domain: `meta_whatsapp_cloud` ve `whatsapp_web_baileys` provider kimliklerini sabitle; capability ve güvenlik metinlerini ayır.
2. Persistence: şifreli Web session/Signal store, lease ve migration ekle.
3. Backend: provider-aware CRUD/list metrics; ayrı Cloud health/webhook ve Web session lifecycle endpointleri.
4. Runtime: tarihsel Baileys connector sınırını PostgreSQL auth store ve worker dispatcher ile bağla.
5. UI: referans platform barı, toolbar, liste/grid kartları, gerçek metrikler ve ayrı bağlantı sihirbazları.
6. Integration: inbox/outbox/realtime/media/RBAC/audit akışlarını provider bazında doğrula.
7. Acceptance: statik kontroller, test/build, görsel inceleme ve gerçek hesap kabul matrisi. Production aktivasyonu release gate sonucuna göre yapılır.

## Referans görsel envanteri

Uygulanacak görsel hiyerarşi: sayfa başlığı ve aksiyonlar; yatay platform segmentleri ve sayaç/Yakında rozetleri; “WhatsApp kanalları” başlığı; arama, durum ve sağlık filtreleri; liste/grid seçimi; checkbox’lı yatay kanal kartları; büyük kanal ikonu; provider ve dış kimlik; durum/health rozetleri; ekip avatarları; son event; açık conversation ve inbound/outbound sayıları; yönet/health/overflow aksiyonları; gecikmiş webhook/session için kart içi uyarı bandı.
