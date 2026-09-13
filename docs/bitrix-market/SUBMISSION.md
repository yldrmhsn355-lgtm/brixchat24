# Brixchat24 — Bitrix24 Market submission pack

This file is the working source for the Global-region Bitrix24 Market card.
Text marked `BLOCKED` must not be copied to the vendor portal until the real
business value has been confirmed.

## Technical card

- Publication region: Global
- Solution type: Use REST API
- Application title: Brixchat24 — WhatsApp Inbox for CRM
- Add custom page and menu item: No
- Embed to BitrixMobile: No
- Add widgets: No
- Installation by a non-administrator: No
- Application URL: `https://brixchat24.com`
- Installation event handler URL: `https://api.brixchat24.com/webhooks/bitrix24/market-install`
- Privacy policy: `https://brixchat24.com/privacy`
- User license agreement: `BLOCKED — public browser-viewable license page required`
- Pricing page: `BLOCKED — real public pricing and commercial terms required`
- Support page: `BLOCKED — verified support channel, schedule and SLA required`

### Required REST scopes

Only request scopes consumed by version 1:

- `crm` — match, read and update CRM contacts/leads and add timeline comments.
- `user_basic` — synchronize active Bitrix24 users, including work email
  addresses used for explicit agent mapping. The application does not create,
  update or delete Bitrix24 users.
- `imopenlines` — create/configure Open Channels, register the external
  connector, exchange messages/statuses and manage sessions.

The current Bitrix24 documentation assigns the `imconnector.*` methods used by
this release to the `imopenlines` scope. Do not request a separate `im` scope;
version 1 does not call `im.*` methods directly.

Do not request `placement`, `contact_center` or `landing_cloud` in version 1.
The current code does not consume those scopes and Bitrix24 rejects excessive
permissions during moderation.

## Global listing — English

### Short description

Connect WhatsApp customer conversations with Bitrix24 CRM and Open Channels so
sales and support teams can work from a shared, auditable inbox.

### Full description

Brixchat24 connects WhatsApp customer communication with Bitrix24 CRM and Open
Channels. It helps sales and support teams keep customer conversations, CRM
context and agent ownership aligned across both systems.

Main capabilities:

- connect an authorized WhatsApp Business channel to a shared team inbox;
- match conversations with Bitrix24 contacts and leads;
- create CRM records according to an administrator-defined policy;
- synchronize Bitrix24 users for agent mapping and assignment;
- route conversations through a dedicated Bitrix24 Open Channel;
- send operator replies and delivery status updates through the connector;
- add controlled conversation context to the Bitrix24 CRM timeline;
- retain operational and audit records for troubleshooting.

Requirements and limitations:

- installation and initial configuration require Bitrix24 administrator access;
- a Brixchat24 account and an authorized WhatsApp Business channel are required;
- WhatsApp Business Platform charges and Brixchat24 service charges may apply;
- Open Channels functionality must be available on the customer's Bitrix24 plan;
- the application runs as a server integration and does not add a Bitrix24 menu page;
- `BLOCKED — insert the confirmed Brixchat24 pricing options and pricing URL`.

Website: https://brixchat24.com

### Installation process

1. A Bitrix24 administrator selects **Install** in Bitrix24 Market and approves
   the requested CRM, Users and Open Channels scopes.
2. Brixchat24 verifies the Bitrix24 portal and administrator identity, creates a
   tenant-scoped connection and displays a one-time setup link.
3. Open the setup link, sign in to an existing Brixchat24 workspace or complete
   the secure workspace claim flow.
4. In Brixchat24, open **Integrations → Bitrix24**, verify the portal connection
   and synchronize Bitrix24 users.
5. Open the WhatsApp channel settings, select the Bitrix24 connection and map it
   to a dedicated Open Channel.
6. Run the connection health check and send a test conversation before enabling
   the channel for production agents.

Uninstalling the application revokes the Bitrix24 connection and removes stored
Bitrix24 authorization credentials. CRM records already created in Bitrix24 are
not deleted.

### Support and feedback

`BLOCKED — add verified support email/helpdesk URL, supported languages, working
days and hours with timezone, and first-response target.`

### Keywords

WhatsApp CRM, shared inbox, customer messaging, Open Channels, CRM timeline,
contact matching, lead routing, agent assignment, customer support

## Türkiye listing — Turkish

### Kısa açıklama

WhatsApp müşteri görüşmelerini Bitrix24 CRM ve Açık Kanallar ile birleştirerek
satış ve destek ekiplerinin ortak, denetlenebilir bir gelen kutusunda çalışmasını
sağlar.

### Tam açıklama

Brixchat24, WhatsApp müşteri iletişimini Bitrix24 CRM ve Açık Kanallar ile
bağlar. Görüşmelerin, CRM bağlamının ve temsilci sorumluluğunun iki sistemde
uyumlu kalmasına yardımcı olur.

Başlıca özellikler:

- yetkilendirilmiş WhatsApp Business kanalını ortak ekip gelen kutusuna bağlama;
- görüşmeleri Bitrix24 kişi ve müşteri adaylarıyla eşleştirme;
- yönetici politikasına göre CRM kaydı oluşturma;
- temsilci eşleme ve atama için Bitrix24 kullanıcılarını eşitleme;
- görüşmeleri kanala özel Bitrix24 Açık Kanal üzerinden yönlendirme;
- operatör yanıtlarını ve teslimat durumlarını konektör üzerinden iletme;
- kontrollü görüşme bağlamını Bitrix24 CRM zaman tüneline ekleme;
- sorun giderme için operasyon ve denetim kayıtlarını saklama.

Gereksinimler ve sınırlamalar:

- kurulum ve ilk yapılandırma için Bitrix24 yönetici yetkisi gerekir;
- Brixchat24 hesabı ve yetkilendirilmiş WhatsApp Business kanalı gerekir;
- WhatsApp Business Platform ve Brixchat24 hizmet ücretleri uygulanabilir;
- Açık Kanallar özelliği müşterinin Bitrix24 planında kullanılabilir olmalıdır;
- uygulama sunucu entegrasyonu olarak çalışır ve Bitrix24 menüsüne sayfa eklemez;
- `BLOCKED — onaylanmış Brixchat24 fiyatlarını ve fiyatlandırma adresini ekle`.

Web sitesi: https://brixchat24.com

### Kurulum açıklaması

1. Bitrix24 yöneticisi Bitrix24 Market'te **Yükle** seçeneğini kullanır ve CRM,
   Kullanıcılar ve Açık Kanallar izinlerini onaylar.
2. Brixchat24 portalı ve yönetici kimliğini doğrular, kuruluşa özel bağlantıyı
   oluşturur ve tek kullanımlık kurulum bağlantısını gösterir.
3. Kurulum bağlantısını açıp mevcut Brixchat24 çalışma alanında oturum açın veya
   güvenli çalışma alanı sahiplenme akışını tamamlayın.
4. Brixchat24 içinde **Entegrasyonlar → Bitrix24** bölümünü açın, portal
   bağlantısını doğrulayın ve Bitrix24 kullanıcılarını eşitleyin.
5. WhatsApp kanal ayarlarından Bitrix24 bağlantısını seçip kanala özel bir Açık
   Kanal ile eşleyin.
6. Bağlantı sağlık kontrolünü çalıştırın ve üretim temsilcilerine açmadan önce
   bir test görüşmesi gerçekleştirin.

Uygulama kaldırıldığında Bitrix24 bağlantısı iptal edilir ve saklanan Bitrix24
yetkilendirme bilgileri silinir. Bitrix24 içinde daha önce oluşturulan CRM
kayıtları silinmez.

### Destek ve geri bildirim

`BLOCKED — doğrulanmış destek e-postası/yardım masası adresi, destek dilleri,
çalışma günleri ve saatleri, saat dilimi ve ilk yanıt hedefini ekle.`

### Anahtar kelimeler

WhatsApp CRM, ortak gelen kutusu, müşteri mesajlaşması, Açık Kanallar, CRM zaman
tüneli, kişi eşleme, müşteri adayı yönlendirme, temsilci atama, müşteri desteği

## Required assets and acceptance

- [x] Opaque 512×512 PNG icon: `assets/brixchat24-icon-512.png`
- [x] Four 1280×720 PNG screenshots containing synthetic demo data:
  `01-inbox.png`, `02-bitrix-overview.png`, `03-open-channels.png`,
  `04-user-mapping.png`
- [ ] Public user license agreement naming Brixchat24 and the legal licensor
- [x] Public privacy page exists
- [ ] Privacy page has verified controller/contact details and clean encoding
- [ ] Public pricing page with real commercial terms
- [ ] Public support page with verified contact channel, hours and response target
- [ ] Clean-portal install test from the vendor card
- [ ] Uninstall verifies token/authorization cleanup in Brixchat24
- [ ] Reinstall succeeds on the same clean portal
- [ ] Administrator and regular-user scenarios checked separately
- [ ] Moderator test workspace/account prepared with synthetic data
- [ ] Vendor agreements and legal entity details completed by the account owner
- [ ] Final **Submit for Moderation** action approved by the account owner
