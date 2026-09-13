# Wazzup çalışma modeli — Brixchat24 uyarlama notları

Brixchat24, Wazzup’ın birleşik ekip gelen kutusu yaklaşımını iletişim katmanında
referans alır; Bitrix24 ise kişi, lead, deal, şirket ve satış süreçlerinin tek
doğruluk kaynağı olmaya devam eder.

## Uygulanacak davranış sözleşmeleri

- Bir telefon + kanal için tek kalıcı konuşma kimliği kullanılır. Durum değişimi
  (açık, bekliyor, ertelendi, kapalı, spam) yeni bir konuşma üretmez.
- Gelen mesaj önce idempotency anahtarıyla kaydedilir, sonra realtime olay ve CRM
  senkronizasyonu yayınlanır. Retry, duplicate mesaj veya duplicate timeline
  kaydı üretmemelidir.
- Atama konuşma sahipliğidir. Atama geçmişi tutulur; Bitrix sorumlusu ile
  eşleşme yoksa mesaj akışı durmaz, kontrollü uyarı ve retry üretilir.
- WhatsApp 24 saat penceresi dışında serbest metin yerine onaylı template
  gönderilir. Bu kural API ve worker katmanında uygulanır; yalnızca UI kuralı
  değildir.
- Bitrix Open Channels aktifken tek bildirim yolu kullanılır. Brixchat24’ın
  normal Bitrix bot bildirimi Open Channels olayının yerine geçmez; duplicate
  operatör bildirimi bastırılır.
- CRM erişilemezliği WhatsApp mesaj kabulünü başarısız yapmaz. CRM işlemi
  ayrı sync job olarak retry edilir ve gözlemlenebilir hata durumu taşır.
- Medya private storage’da tutulur; tenant kontrolü signed URL üretiminden önce
  yapılır ve malware taraması geçmeyen nesne için preview/download verilmez.

## Kapsam sınırı

Bu referans Meta WhatsApp Cloud API ve resmi Bitrix24/Open Channels bağlantısı
içindir. WhatsApp Web, QR oturumu, Baileys veya grup scraping uygulanmaz.

## Mevcut durum

Konuşma durumları, atama, 24 saat/template altyapısı, SSE ve idempotent mesaj
kaydı mevcut backend’de bulunur. Open Channels’ın gerçek operatör köprüsü,
session close/reopen ve delivery-status senkronizasyonu ise harici kabul testi
bekleyen sonraki dilimlerdir.
