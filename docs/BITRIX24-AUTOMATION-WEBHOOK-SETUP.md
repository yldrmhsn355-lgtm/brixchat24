# Bitrix24 otomasyon kuralı → WhatsApp gönderim webhook'u

Bu doküman, bir Bitrix24 CRM **otomasyon kuralının** (business process / "Robotlar"
adımı olarak eklenen **Dış Webhook / Исходящий вебхук**) Brixchat24'e istek atarak
doğrudan bir WhatsApp şablon mesajı göndertmesini anlatır. Bu yol **Bitrix24 Açık
Kanal (Open Channels)** widget'ını hiç kullanmaz — [BITRIX24-SETUP.md](BITRIX24-SETUP.md)'de
anlatılan `crm_context` modunun tersi yönü: oradaki akış Brixchat24 → Bitrix24 CRM'e
lead/deal/timeline yazar; buradaki akış Bitrix24 CRM otomasyonu → Brixchat24'e mesaj
gönderttirir.

## Nasıl çalışır

1. Bağlantı sahibi, aşağıdaki API çağrısıyla tek kullanımlık bir webhook URL'si üretir:

   ```bash
   curl -X POST "$API_PUBLIC_URL/api/v1/integrations/bitrix24/<connectionId>/automation-webhook/rotate" \
     -H "Authorization: Bearer <token>"
   ```

   Yanıt, secret'ı **sadece bu seferlik** açık metin olarak içeren tam URL'yi döner:

   ```json
   { "data": { "webhookUrl": "https://api.example.com/webhooks/bitrix24/<connectionPublicId>/automation/<secret>" } }
   ```

   Bu URL'yi kaydedin — tekrar sorgulanamaz; kaybederse `rotate` yeniden çağrılıp
   eskisi geçersiz kılınarak yenisi üretilir.

2. (İsteğe bağlı ama önerilir) Otomasyon kuralının her seferinde bir kanal
   belirtmesini istemiyorsanız, bağlantı için varsayılan bir WhatsApp kanalı
   atayın:

   ```bash
   curl -X PATCH "$API_PUBLIC_URL/api/v1/integrations/bitrix24/<connectionId>/automation-webhook" \
     -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
     -d '{"channelId":"<channels.id>"}'
   ```

3. Bitrix24 tarafında, ilgili CRM otomasyon kuralına (lead/deal/contact üzerinde,
   Otomasyon Kuralları veya İş Süreçleri tasarımcısından) bir **"Dış Webhook"**
   adımı ekleyin ve hedef URL olarak 1. adımdaki URL'yi yapıştırın. Ekstra header
   veya parametre eşleştirmesi **gerekmez** — secret URL'nin içinde taşınıyor.

4. Adımın gönderdiği alanları (form/JSON, admin nasıl yapılandırırsa) şu şekilde
   eşleyin:

   | Alan | Zorunlu | Açıklama |
   |---|---|---|
   | `entity_type` | evet | `lead`, `deal` veya `contact` |
   | `entity_id` | evet | Bitrix CRM kaydının ID'si (`{{=Document:ID}}`) |
   | `phone` | evet | Bitrix'in çözdüğü telefon alanı, örn. `{{=Document:PHONE}}` |
   | `template_name` | evet | Gönderilecek onaylı WhatsApp şablonunun adı |
   | `channel_id` | hayır | Belirli bir WhatsApp kanalı (`channels.id`); verilmezse bağlantının varsayılan kanalı kullanılır |
   | `contact_name` | hayır | Yeni kişi/konuşma oluşturulacaksa gösterilecek isim |
   | `variables` | hayır | Şablon değişkenleri, `{"1":"Ahmet","2":"12345"}` gibi anahtar/değer |
   | `idempotency_key` | hayır | Verilmezse `entity_type+entity_id+template_name+phone` ve dakika penceresinden türetilir; Bitrix'in aynı çalışmayı tekrar POST etmesi durumunda çift gönderimi engeller |

5. İstek kabul edildiğinde `202 Accepted` döner ve iş `crm_sync_jobs` tablosuna
   `job_type='automation.send_whatsapp'` olarak yazılır; worker (`apps/worker/src/index.ts`
   → `processCrmJob()`) bunu alıp telefon için kişi/konuşmayı bulur veya oluşturur,
   onaylı şablonu doğrular ve `executeAutomationTemplateAction()` üzerinden aynı
   opt-in/tekrar-limiti/değişken çözümleme mantığıyla gönderimi kuyruğa alır.

## Güvenlik notu

Webhook URL'si, içindeki secret'la birlikte **bir parola gibi** ele alınmalıdır.
URL'yi paylaşmayın, ekran görüntüsüne almayın veya destek biletlerine yapıştırmayın.
Sızdığını düşünüyorsanız `rotate` uç noktasını tekrar çağırarak eski URL'yi anında
geçersiz kılın.

## Hata durumları

- Kanal ayarlanmamış/bulunamamış veya bağlı değilse: iş `dead_letter` durumuna düşer,
  `crm_sync_logs`'a nedeniyle birlikte yazılır — retry denemez (yapılandırma
  sorununun kendiliğinden düzelmeyeceği varsayılır).
- `template_name` bu kanal için onaylı bir şablonla eşleşmiyorsa: aynı şekilde
  `dead_letter`.
- Telefon numarası ayrıştırılamıyorsa: aynı şekilde `dead_letter`.

Bu durumların hepsi `crm_sync_logs` tablosunda, ilgili `job_id` ile görüntülenebilir.
