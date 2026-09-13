# Brixchat24 canlı ortam son kabul raporu

**Tarih:** 10 Eylül 2026  
**Sonuç:** Kabul kontrolleri geçti; web, API, worker ve veri servisleri bu Windows Server üzerinde canlıdır.

## Canlı erişim

| Bileşen | Adres | Sonuç |
|---|---|---|
| Web | https://brixchat24.com/ | Giriş sayfasına yönleniyor; HTTP 200 sonrası `/login` |
| Giriş | https://brixchat24.com/login | HTTP 200 |
| Entegrasyonlar | https://brixchat24.com/app/integrations | HTTP 200 |
| Kampanyalar | https://brixchat24.com/app/campaigns | HTTP 200 |
| API sağlık | https://api.brixchat24.com/health | HTTP 200 |
| API hazırlık | https://api.brixchat24.com/health/ready | HTTP 200, `ready` |

DNS kayıtlarında `brixchat24.com` ve `api.brixchat24.com` adresleri `45.155.124.216` sunucusuna çözülür. DNS Hostinger tarafından yönetilir; Cloudflare kullanılmaz.

## IIS, servisler ve portlar

IIS siteleri `Brixchat24-Public` ve `Brixchat24-API` durumunda `Started` olarak doğrulandı. Yerel demo sitesi `Brixchat24` yalnızca localhost:8080 üzerinde korunur.

| Windows servisi | Hesap | Başlangıç | Yerel uç | Bellek / CPU üst sınırı |
|---|---|---|---|---|
| Brixchat24-Web | `NT SERVICE\Brixchat24-Web` | Automatic / Running | 127.0.0.1:3310 | 2304 MiB / %35 |
| Brixchat24-API | `NT SERVICE\Brixchat24-API` | Automatic / Running | 127.0.0.1:4410 | 1792 MiB / %30 |
| Brixchat24-Worker | `NT SERVICE\Brixchat24-Worker` | Automatic / Running | 127.0.0.1:4110 | 1536 MiB / %25 |
| Brixchat24-PostgreSQL | `NT SERVICE\Brixchat24-PostgreSQL` | Automatic / Running | 127.0.0.1:5434 | 3072 MiB / %35 |
| Brixchat24-Redis | `NT SERVICE\Brixchat24-Redis` | Automatic / Running | 127.0.0.1:6381 | 1024 MiB / %15 |
| Brixchat24-ClamAV | `NT SERVICE\Brixchat24-ClamAV` | Automatic / Running | 127.0.0.1:3311 | 2048 MiB / %25 |

Kaynak sınırları Windows Job Object ile çekirdek seviyesinde uygulanır. Alt süreçler aynı sınırlara dahildir; kurulum başarısız olursa servis başarılı görünmez. Bellek sınırı ayrıca 128 MiB test işiyle fiilen doğrulandı. Servisler hata sonrası otomatik yeniden başlar, loglar boyuta göre döner.

## Dizinler

| Amaç | Konum |
|---|---|
| Canlı sürüm | `C:\ProgramData\Brixchat24\releases\20260910-media` |
| Korumalı ayarlar | `C:\ProgramData\Brixchat24\live` |
| Servis araçları | `C:\ProgramData\Brixchat24\services` |
| Özel medya | `C:\ProgramData\Brixchat24\media` |
| PostgreSQL veri | `C:\ProgramData\Brixchat24\pgdata` |
| Redis veri | `C:\ProgramData\Brixchat24\redis-data` |
| Loglar | `C:\ProgramData\Brixchat24\logs` |
| Yedekler | `C:\ProgramData\Brixchat24\backups` |
| IIS web kökü | `C:\inetpub\Brixchat24-Public` |
| IIS API kökü | `C:\inetpub\Brixchat24-API` |

Gerçek şifreler, anahtarlar ve oturum verileri bu rapora yazılmadı. Canlı sürümde `.git`, test çıktıları ve geliştirme verileri yoktur; bağımlılıklar frozen lockfile ile yeniden kurulmuştur.

## HTTPS ve ağ güvenliği

- Apex/www sertifikası ve API sertifikası geçerlidir; ikisi de 8 Aralık 2026 tarihinde sona erer.
- win-acme yenileme görevi ve yenilenen sertifikayı IIS'e bağlayan `Brixchat24-Certificate-Sync` görevi son çalıştırmada sonuç `0` verdi.
- HTTP istekleri HTTPS'e yönlenir. HSTS, CSP, `nosniff`, çerçeve ve referrer başlıkları uygulanır.
- CORS yalnızca `https://brixchat24.com` origin değerine izin verir. Yabancı origin 403 ile reddedilir.
- API yalnızca yerel IIS proxy adresi `127.0.0.1` için proxy başlıklarına güvenir.
- WebSocket desteği, 10 dakikalık proxy zaman aşımı ve 30 MiB API yükleme sınırı IIS üzerinde ayarlıdır.

## Veritabanı, RLS ve kalıcı veri

- PostgreSQL 17.11 ve Redis 7.4.9 yerel servis olarak çalışır. PostgreSQL bağlantıları TLS `verify-full` kullanır; Redis AOF açıktır.
- Canlı veritabanında 49 migration uygulanmıştır.
- API control, API tenant-scoped ve worker hesapları ayrıdır; uygulama hesapları superuser değildir.
- 146 tabloda RLS doğrulandı. Tenant dışı okuma/yazma, kimlik bilgisi erişimi ve tenantlar arası ilişki ihlali testleri reddedildi.
- Üretim verileri silinmedi, yeniden seed edilmedi ve şifreleme anahtarları değiştirilmedi.

## Medya güvenliği

- Dosyalar IIS dışında özel `filesystem` sağlayıcısında tutulur. Web servis hesabının medya klasörüne erişimi yoktur; API ve worker yalnızca gereken haklara sahiptir.
- Yol geçişi, Windows ayrılmış adları, symlink/junction, üzerine yazma ve kısmi dosya riskleri engellenir.
- Yüklemeler yayımlanmadan önce yerel ClamAV ile taranır; 25 MiB sınırı ve süreli imzalı indirme bağlantıları uygulanır.
- Gerçek disk yazma/okuma/silme, temiz ve zararlı örnek taraması, tenant izolasyonu, bozuk imza ve tarayıcı erişilemezken güvenli hata davranışı geçti.
- Dosya indirmede boş gövde üreten ertelenmiş yanıt hatası düzeltildi.

## Kampanya güvenliği

- Türkçe/İngilizce CSV başlıkları, doğrulama, tekrar ayıklama, alıcı ve hat seçimi, önizleme ve dry-run çalışır.
- Onay/24 saat penceresi/şablon/kota kontrolleri, idempotency, advisory lock, worker satır kilidi, alıcı durumları ve iptal akışı uygulanır.
- Gerçek gönderim açık onay olmadan başlatılamaz. Canlı doğrulamada kampanya ve bekleyen outbox sayısı `0` kaldı; müşteri mesajı gönderilmedi.

## Entegrasyonlar ve WhatsApp

Meta, WhatsApp, Bitrix24, AI, SMTP ve benzeri firma bağlantıları uygulamanın açılması için zorunlu değildir. Firma giriş yaptıktan sonra Entegrasyonlar ekranından kendi hesabını bağlar. Yapılandırılmamış isteğe bağlı sağlayıcılar web/API/worker başlangıcını engellemez.

Sunucu yeniden başladıktan sonra mevcut WhatsApp Web oturumu, kayıtlı şifreli kimlik bilgileriyle yeniden bağlandı. Son durum `connected / ACTIVE / HEALTHY`, yeniden deneme sayısı `0`, hata kodu boş ve yeni QR gerekmiyor. Kanıt: `C:\ProgramData\Brixchat24\logs\whatsapp-web-final-state.json`.

## Yedekleme ve geri yükleme

- `Brixchat24-Live-Backup` her gün 03:15'te SYSTEM hesabıyla çalışır; son sonucu `0`dır.
- İşlem API/worker yazıcılarını kısa süre durdurur, PostgreSQL arşivi ile özel medyayı birlikte alır, SHA-256 değerlerini doğrular ve önceki servis durumunu geri getirir.
- Ayrı geri yükleme veritabanı ve ayrı medya klasörüyle tatbikat geçti: 156 tablo, 49 migration, 1 firma, 1 kullanıcı, 146 RLS tablosu ve medya hash doğrulaması.
- Üretim veritabanının üzerine yazılmadı. Sunucu dışı ikinci yedek kopyası henüz yapılandırılmadı; felaket kurtarma için önerilir.

## Yeniden başlatma ve zamanlanmış kontroller

Windows'un gerçek son açılış zamanı `2026-09-10 19:26:51Z` olarak kaydedildi. Açılış sonrası `Brixchat24-Post-Reboot-Verification` görevi tekrar çalıştırıldı ve 26/26 kontrolü geçti: altı servis, altı kaynak sınırı, IIS, HTTPS, API readiness, worker, PostgreSQL, Redis, yalnızca loopback portları ve iki sertifika. Son kontrol `2026-09-10 19:43:34Z`, görev sonucu `0`.

Diğer görevlerin son sonucu da `0`: canlı yedek, ClamAV güncellemesi, beş dakikalık sağlık kontrolü, sertifika eşleme ve win-acme yenilemesi. Sağlık değişiklikleri yerel loga yazılır; harici e-posta/SMS alarm alıcısı yapılandırılmadı.

## Doğrulama özeti

| Kontrol | Sonuç |
|---|---|
| Production build | 13/13 başarılı |
| TypeScript | 13/13 başarılı |
| Lint | 13/13 başarılı; 0 hata, 5 mevcut uyarı |
| Architecture check | Başarılı |
| Campaign API/DB/HTTP/UI | 83 test ve masaüstü/mobil akış başarılı |
| Filesystem medya | 89 paket testi + 58 API/scope/medya testi başarılı |
| Proxy/client IP | 18/18 başarılı |
| RLS ve tenant izolasyonu | 65 güvenlik testi başarılı |
| Birleşik yedek geri yükleme | Başarılı |
| Gerçek Windows restart | 26/26 açılış sonrası kontrol başarılı |

`graphify update .` komutu sunucuda graphify CLI kurulu olmadığı için çalıştırılamadı. Projede `graphify-out/graph.json` bulunmuyor; `pnpm architecture:check` başarılıdır. Bu durum çalışan üretim servislerini etkilemez.

## Kullanıcı işlemleri

Altyapıyı canlıya almak için ek işlem gerekmiyor. Yönetici `hsnyldrm-590@hotmail.com` hesabıyla giriş yapabilir. Her firma, kullanacağı Meta/WhatsApp/Bitrix24/AI/SMTP hesaplarını Entegrasyonlar ekranından kendisi bağlamalıdır. Operasyonel dayanıklılık için yedeklerin sunucu dışı bir hedefe kopyalanması ve sağlık logları için harici bildirim alıcısı eklenmesi önerilir.

## Kanıt dosyaları

- `C:\ProgramData\Brixchat24\logs\reboot-verification.json`
- `C:\ProgramData\Brixchat24\logs\final-public-http.json`
- `C:\ProgramData\Brixchat24\logs\whatsapp-web-final-state.json`
- `C:\ProgramData\Brixchat24\logs\live-verification.json`
- `C:\ProgramData\Brixchat24\logs\media-activation.json`
- `C:\ProgramData\Brixchat24\logs\campaign-live-verification.json`
- `C:\ProgramData\Brixchat24\backups\combined-restore-drill-latest.json`
- `C:\ProgramData\Brixchat24\logs\resource-memory-enforcement-result.json`
