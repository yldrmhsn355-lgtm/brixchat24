# WhatsApp Web hazırlık ve kabul runbook'u

Bu runbook, Baileys tabanlı bağlı cihaz özelliğinin güvenli biçimde
hazırlanması içindir. WhatsApp Web resmi Meta Cloud API değildir. Hesap
kısıtlaması, telefon bağlantısı, QR yenileme ve session kaybı riski vardır.

## Cloud API entegrasyonundan kullanılan ortak katmanlar

WhatsApp Web ikinci bir inbox veya mesaj veritabanı oluşturmaz. Cloud API ile
aynı ortak altyapıyı kullanır:

- transactional outbox ve idempotent provider message ID akışı
- object storage ve temiz attachment kapısı
- tenant-safe contact, conversation ve message repository'leri
- delivery/read status güncellemesi
- CRM timeline kuyruğu
- `conversation.created` ve `message.created` realtime projeksiyonu
- inbox, RBAC, audit ve kanal filtreleri

Yalnızca transport katmanı ayrıdır. Cloud API access token, Graph API,
webhook signature ve template kullanır. WhatsApp Web ise Baileys socket, QR,
Signal auth store, LID eşlemesi, worker lease ve reconnect kullanır. Cloud
credential veya webhook kodu WhatsApp Web session'ına taşınmaz.

## Değişmez güvenlik sınırları

- `WHATSAPP_WEB_ENABLED` bütün hazırlık kapıları geçene kadar `false` kalır.
- QR görünmesi veya taranması tek başına başarı değildir.
- Normal reconnect sırasında conversation, contact veya message kayıtları
  silinmez.
- Auth temizliği gerekirse yalnızca hedef channel session ve Signal
  anahtarları kapsamındadır.
- Production migration veya aktivasyon, doğrulanmış backup/restore kanıtı
  olmadan yapılmaz.
- Aynı channel için aynı anda yalnızca bir worker lease ve bir Baileys socket
  çalışmalıdır.
- QR, credentials ve Signal anahtar içerikleri loglanmaz veya raporlanmaz.

## 1. Statik hazırlık kapıları

Komutları repository kökünde çalıştır:

```powershell
cd "C:\Users\pc\Desktop\Brixchat24-LIVE"
pnpm db:migrate:check
pnpm --filter @brixchat/whatsapp-web test
pnpm --filter @brixchat/whatsapp-web build
pnpm --filter @brixchat/worker build
```

Production için ayrıca backup/restore kanıtının ayrı olarak geçmesi gerekir:

```powershell
pnpm recovery:backup-restore:production
```

Bu komutun geçmesi migration'ın otomatik uygulanmasına izin vermez; yalnızca
zorunlu kanıtlardan biridir.

## 2. Güvenli session envanteri

`whatsapp-web:preflight` salt okunurdur. QR, credentials veya key değerlerini
decrypt etmez; sadece varlık bilgisi, lease ve key-family sayılarını gösterir.

```powershell
$env:DATABASE_URL="<target database URL>"
$env:WHATSAPP_WEB_CHANNEL_ID="<channel UUID or public ID>"
pnpm whatsapp-web:preflight
```

Çıktıyı aşağıdaki üç noktada ayrı artifact olarak sakla:

1. QR eşleştirmeden önce.
2. Session `connected` olduktan sonra.
3. Worker kontrollü yeniden başlatıldıktan sonra.

Baileys v7 için raporlanan aileler:

- `pre-key`
- `session`
- `sender-key`
- `sender-key-memory`
- `app-state-sync-key`
- `app-state-sync-version`
- `lid-mapping`
- `device-list`
- `tctoken`
- `identity-key`

Sayıların her ailede mutlaka sıfırdan büyük olması beklenmez. Kabul ölçütü,
bağlantı sırasında oluşan anahtarların restart sonrasında kaybolmaması ve
beklenmedik toplu düşüş olmamasıdır.

## 3. Kontrollü eşleştirme

Yerel geliştirme ortamında varsayılan Compose dosyasını değiştirmeden opt-in
override kullan:

```powershell
docker compose -f docker-compose.yml -f docker-compose.whatsapp-web.yml up -d --build
```

Bu override yalnızca API ve worker servislerinde
`WHATSAPP_WEB_ENABLED=true` ayarlar. Production deployment tanımında otomatik
olarak kullanılmaz.

1. Hedef ortamda migration `0015_whatsapp_web_sessions.sql` uygulamasını
   doğrula.
2. API ve worker'ın aynı `APP_ENCRYPTION_KEY` değerini kullandığını doğrula.
3. Hedef channel dışında WhatsApp auth/session kaydına dokunma.
4. Worker'da özelliği açmadan önce hedef channel için aktif lease olmadığını
   preflight çıktısıyla doğrula.
5. `WHATSAPP_WEB_ENABLED=true` ayarını yalnızca hedef worker servisinde aç.
6. Kanal ekranından üretilen kısa ömürlü QR'ı tara.
7. Session `connected`, `hasCredentials=true`, `hasQr=false` olana kadar
   preflight ile doğrula.

## 4. Tek worker/socket ve restart kalıcılığı

Deployment platformunda hedef worker'ı graceful biçimde durdur. Eski process
tamamen kapanmadan yeni worker başlatma. Yeni worker başladıktan sonra:

- Tek aktif process/replica olduğunu platformdan doğrula.
- Preflight çıktısında tek `assignedWorkerId` ve aktif lease gör.
- Key-family sayılarını restart öncesi artifact ile karşılaştır.
- Session'ın yeni QR istemeden tekrar `connected` olduğunu doğrula.

Platforma özel process komutları bu runbook'a sabitlenmemiştir. PM2, Docker veya
Railway üzerinde doğrulanmış servis adı ve replica sayısı kullanılmalıdır.

## 5. Gerçek mesaj kabul kapısı

Restart sonrasında başka bir WhatsApp hesabından benzersiz bir metin gönder:

```text
BRIX-WWEB-IN-YYYYMMDD-HHMM
```

Aşağıdaki zincirin tamamını kanıtla:

1. Baileys `messages.upsert` olayı mesajı boş olmayan içerikle alır.
2. Aynı provider message ID için yalnızca bir message satırı oluşur.
3. Doğru channel/contact/conversation ilişkisi kurulur.
4. Unread sayısı artar ve inbox sıralaması güncellenir.
5. Realtime event istemcide görünür.
6. Aynı conversation üzerinden outbound yanıt gönderilir ve provider message
   ID alınır.

Mesaj `type=empty`, decrypt hatası veya eksik LID eşlemesiyle gelirse kabul
başarısızdır. QR/session başarısı ayrı raporlanır; uçtan uca başarı ilan edilmez.

## 6. GO / NO-GO

Production aktivasyonu yalnızca şu kanıtların tamamı varsa `GO` olabilir:

- Backup/restore kanıtı.
- Migration safety ve migration uygulama kanıtı.
- Auth key-family restart kalıcılığı.
- Tek worker/socket kanıtı.
- Benzersiz inbound ve outbound gerçek mesaj kanıtı.
- QR/credentials/key materyalinin log veya API yanıtında açığa çıkmadığı kanıtı.

Bir kapı eksikse `WHATSAPP_WEB_ENABLED=false` korunur ve sonuç `NO-GO` olarak
raporlanır.
