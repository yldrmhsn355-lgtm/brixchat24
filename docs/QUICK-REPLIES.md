# Hazır Cevaplar Yönetim Merkezi

Hazır Cevaplar, Brixchat24 içinde yönetilen ve yalnızca açık WhatsApp müşteri
hizmeti penceresinde serbest mesaj olarak kullanılan dahili içeriklerdir. Meta
onaylı WhatsApp şablonlarıyla aynı veri modelini veya gönderim yolunu kullanmaz.

## Kapsam ve erişim

- `personal`: yalnızca sahibi okuyabilir ve yönetebilir.
- `team`: yalnızca ekip üyeleri okuyabilir; ekip yöneticileri yönetebilir.
- `organization`: workspace genelinde okunur; workspace yöneticileri yönetir.
- İsteğe bağlı `channel_id`, cevabı belirli WhatsApp kanalına sınırlar.
- Arşivlenen ve soft-delete edilen kayıtlar Inbox önerilerinde görünmez.
- `version` alanı eşzamanlı düzenlemelerde sessiz veri ezilmesini engeller.

## İçerik ve değişkenler

Metin, WhatsApp biçimlendirmesini ve satır sonlarını olduğu gibi korur. Dahili
değişkenler `{{contact.first_name}}` biçimindedir. Contact, kullanıcı, ekip,
workspace, kanal, konuşma, tarih/saat ve bağlıysa `bitrix.contact.*`,
`bitrix.deal.*`, `bitrix.task.*` kaynakları render sırasında çözülür.

Çözülemeyen bir değişken composer'a eklemeyi durdurur. Son savunma olarak
outbound message repository de çözülmemiş `{{...}}` içeren metni `409
QUICK_REPLY_VARIABLES_UNRESOLVED` ile reddeder.

## Medya

İlk sürüm tek metin ve en fazla bir attachment destekler. Görsel, video, ses ve
izin verilen belge türleri private object storage'a yazılır; boyut sınırı 25 MB
ve mevcut MIME/magic-byte/malware hattı kullanılır. Temiz olmayan dosya hazır
cevaba bağlanmaz. Gönderimde dosya yeni bir message attachment nesnesine
kopyalanır; kaynak dosya ile mesaj retention yaşam döngüleri birbirini bozmaz.

Çok mesajlı sequence/package arayüzü özellikle eklenmedi. Böyle bir özellik,
ayrı ve idempotent bir queue/sequence modeli olarak tasarlanmalıdır.

## Kullanım olayları ve analitik

Liste görüntüleme kullanım sayılmaz. `selected`, `sent`, `failed` ve
`variable_error` olayları ayrı tutulur. `usage_count` ve `last_used_at` yalnızca
gerçek `sent` olayında güncellenir. Analitik endpoint'i seçilen tarih aralığında
gönderim, hata, aktif temsilci, en çok kullanılan cevap ve günlük trend
verilerini gerçek olaylardan üretir.

## İçe ve dışa aktarma

CSV içe aktarma önce sunucu tarafı önizleme yapar. Kapsam/RBAC, ekip, kategori,
normalizasyon, dosya içi tekrar ve mevcut shortcut çakışmaları doğrulanır. Bir
engel varsa commit yapılmaz; onaylanan batch tek transaction içinde yazılır.
Dışa aktarma yalnızca kullanıcının görmeye yetkili olduğu kayıtları döndürür.

## Production kontrol listesi

1. Production veritabanı yedeğinin geri yüklenebilir olduğunu doğrula.
2. `0012_quick_reply_center.sql` migration planını ve hedef DB durumunu kontrol et.
3. Production storage ve malware scanner health kontrollerini doğrula.
4. `pnpm db:migrate:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
   `pnpm architecture:check` ve `pnpm build` çalıştır.
5. Migration'ı backup kanıtından sonra uygula.
6. Personal/team/organization görünürlüğü için production smoke testi yap.
7. Açık pencerede metin ve attachment gönderimini, kapalı pencerede
   `WHATSAPP_TEMPLATE_REQUIRED` ve Meta şablonuna yönlendirmeyi doğrula.
8. `selected`, `sent`, `failed` ve `variable_error` olaylarının analitiğe
   doğru yansıdığını kontrol et.

Bitrix24 bağlantısı zorunlu değildir. Bağlantısız workspace'lerde CRUD, arama,
Inbox ve gönderim normal çalışır; yalnızca Bitrix değişkeni kullanan içerik,
bağlantı/context yoksa kontrollü eksik-değişken durumuna geçer.
