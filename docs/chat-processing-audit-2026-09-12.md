# Sohbet metin ve medya işleme incelemesi

Tarih: 12 Eylül 2026, 08:36 PDT. Sonuç: temel akış çalışmış, ancak tüm formatların ve güncel gönderim/alımın eksiksiz çalıştığı söylenemez. İnceleme salt okunur yapıldı; gerçek mesaj gönderilmedi, tenant kayıtları değiştirilmedi.

## Canlı kanıt

| Tür | Gözlem | Doğrulama sınırı |
| --- | --- | --- |
| Metin | 200 gelen, 130 giden kayıt; boş gövde yok. Gidenlerin 125'i delivered/read, 5'i sent. | Kayıt bütünlüğü, tam teslim garantisi değildir. İçerikler okunmadı. |
| Ses | 4 gelen + 4 giden Ogg/Opus; 8 ek stored/clean. | Sekiz dosya diskte, boyut/SHA-256 eşleşiyor. Dinleme ve tüm tarayıcılarda decode testi yapılmadı. |
| Görsel | 16 JPEG: 15 stored/clean, 1 failed/not_scanned. | Başarılı 15 dosyanın boyut/SHA-256 değerleri doğru. |
| Sticker | 3 WebP stored/clean. | Üç dosyanın boyut/SHA-256 değerleri doğru. |
| Belge | 3 gelen PDF stored/clean. | Üç dosyanın boyut/SHA-256 değerleri doğru. Diğer belge biçimleri canlı örnekle doğrulanmadı. |
| Video | Canlı video kaydı yok. | Arayüz/normalizasyon desteği var; uçtan uca video başarısı kanıtlanmış değil. |

Toplam 30 medya mesajının hiçbirinde ek kaydı eksik değil. 29 ek depolanmış ve tarama sonucu clean; hepsinin fiziksel dosyası, boyutu ve SHA-256 özeti doğrulandı. Bu kontroller medyanın bozulmadan saklandığını gösterir, oynatılabildiğini tek başına kanıtlamaz.

Worker heartbeat 4,6 saniye önce, healthy. Outbox ve WhatsApp inbound retry tabloları boş. Medya kuyruğunda 29 completed ve 1 dead_letter var. WhatsApp Web DISCONNECTED; oturum logged_out. Son kopuş 11 Eylül 2026 14:42 PDT. Hata kodu boş olduğundan çıkışın nedeni belirlenemiyor; yeniden bağlantı olmadan yeni WhatsApp Web trafiği çalışmaz.

## Öncelikli bulgular ve düzeltme sırası

1. **P1 — Mikrofon kaydı ile API formatları uyumsuz.** `apps/web/app/app/inbox/workspace.tsx:2312` varsayılan MediaRecorder formatını kullanıyor; MIME değeri uploadMedia ile doğrudan API'ye aktarılıyor. `packages/integrations/src/media/index.ts:371` WebM sesi kabul etmiyor; codec parametreli Ogg de tam dize karşılaştırmasında reddediliyor. Sentetik denemede audio/webm;codecs=opus ve audio/ogg;codecs=opus için uploadAllowed=false doğrulandı. API `milestone5-routes.ts:995` 415 döndürüyor. MIME normalizasyonu, hedef sağlayıcıyla uyumlu codec seçimi/dönüşümü ve gerçek tarayıcı kayıt testi gerekli. Sadece uzantı değiştirmek yeterli değil.
2. **P1 — Başarısız ses gönderimi kayıt önizlemesini temizliyor.** `workspace.tsx:2272` uploadMedia hatayı yakalayıp başarı durumu döndürmüyor; `workspace.tsx:2358` sendVoiceRecording her durumda voiceBlob'u siliyor. Başarısız yüklemede kayıt saklanmalı, tekrar deneme sunulmalı.
3. **P1 — Format izin listesi ile dosya tanıma kapsamı uyuşmuyor.** `packages/integrations/src/media/index.ts:399` tanıyıcı sadece JPEG, PNG, WebP, PDF, ftyp, Ogg ve ZIP imzalarını tanıyor. Gelen MP3, GIF, TXT/CSV, eski Office ve WebM izinli olmasına rağmen detected boş olduğundan `apps/worker/src/index.ts:1665` tarafından MEDIA_SIGNATURE_DENIED ile reddedilebilir. DOCX/XLSX/PPTX ZIP olarak sınıflanıyor; MP4 ses/video ayrımı da yapılmıyor. Güvenli format tanıma, MIME eşleştirmesi ve temsilî dosya testleri gerekli. Kontrolü kaldırmak doğru çözüm değil.
4. **P1 — Canlıda bir görsel kurtarma bekliyor.** MEDIA_OBJECT_CLEANUP_FAILED, 5 deneme, dead_letter; ek failed/not_scanned. Geçici/önceki nesnelerin temizliği ve dosya sistemi erişimleri incelenmeli; temizleme hatası çözülüp kontrollü yeniden işleme yapılmalı. Bu incelemede yeniden kuyruğa alınmadı; kök neden yalnızca hata kodundan çıkarılamaz.
5. **P2 — Gelen tüm medyalara görsel limiti uygulanıyor.** `apps/worker/src/index.ts:1667` ses/video/belge için de MEDIA_MAX_IMAGE_BYTES kullanıyor; kod varsayılanı 10.000.000 bayt. Upload ve filesystem katmanı 25 MiB sınırına sahip. Canlıdaki etkin limit değeri bu raporda doğrulanmadı. Tür ve sağlayıcı bazında tutarlı sınırlar, UI açıklaması ve sınır testleri gerekli.
6. **P2 — Medya URL'leri eskidiğinde yenilenmiyor.** `apps/api/src/milestone5-routes.ts:848` indirme URL'sini 300 saniyelik veriyor; thumbnail 180 saniyelik. `workspace.tsx:1399` URL'leri kimlikle önbelleğe alıp yalnızca eksikse yeniden istiyor; expiresAt kullanılmıyor. Yeniden ağ isteği gereken uzun oturumlarda önizleme/oynatma başarısız olabilir; her oynatma tam beşinci dakikada kesilir anlamına gelmez. Süreye göre yenileme, 403/medya hatası sonrası tek kontrollü retry ve görünür hata gerekli.
7. **P2 — Ses/video servisinde oynatma desteği sınırlı.** `milestone5-routes.ts:952` yerel dosyayı application/octet-stream ve attachment disposition ile gönderiyor; route düzeyinde Range/206 işlemesi yok. Tarayıcının ileri sarma davranışı ayrıca test edilmeli; MIME, uzunluk ve byte-range desteği eklenmeli. `message-attachment.tsx:238` ses bileşeninde yükleme/oynatma hatasına görünür geri bildirim eksik.
8. **P3 — Başarılı retry eski job hatasını koruyor.** Bir completed işte MEDIA_SCAN_FAILED kalmış. `apps/worker/src/index.ts:1733` completed güncellemesi last_error alanını sıfırlamıyor. Ek stored/clean olduğu için aktif tarama arızası olarak sayılmamalı. Tamamlanmada güncel hata temizlenip geçmiş denemeler ayrı tutulmalı.

WhatsApp oturumunun kullanıcı tarafından yeniden bağlanması, yeni alım/gönderim doğrulamasının ön koşuludur. Bunun yanında pollUpdateMessage (4) ve pinInChatMessage (1) unsupported olarak kaydedilmiş. Diğer kontrol/transport zarflarının atlanması tek başına içerik kaybı kanıtı değildir.

## Yapılan kontroller

- Canlı worker, integrations/media, API route ve inbox workspace kaynaklarının SHA-256 değerleri incelenen workspace dosyalarıyla eşleşti.
- Salt okunur PostgreSQL transaction ve fiziksel dosya hash/boyut kontrolü: `scripts/audit-chat-processing.sql`, `scripts/audit-chat-files.ps1` (PowerShell 7).
- Sentetik MIME/imza deneyi: `pnpm exec tsx scripts/audit-chat-mime.ts`. Gerçek müşteri dosyası veya ağ yazması yok.
- Worker: media-safety 7 + inbound-media-source 3 test geçti.
- WhatsApp normalizer: 14 test geçti.
- UI: message-presentation 4 + message-attachment 4 test geçti. Bunlar gerçek tarayıcı codec/oynatma testleri değildir.
- Storage/scanner: filesystem 8 + clamav 9 + disabled 1 test geçti. Bunlar mevcut canlı tarayıcı/scanner uçtan uca doğrulamasının yerine geçmez.
- Toplam **50 hedefli test geçti**. Entegrasyon testleri canlı veritabanına karşı çalıştırılmadı.

Üretim kodu ve canlı veriler değiştirilmedi. Bu rapor incelemeyi tamamlar; yukarıdaki sorunların giderildiğini iddia etmez. Düzeltmeler sonrasında izole tenant/DB'de metin, mikrofon kaydı, Ogg/MP3, JPEG/PNG/GIF, PDF/Office/TXT/CSV, MP4/WebM; büyük dosya, süresi dolmuş URL, ileri sarma ve yeniden deneme senaryoları doğrulanmalı. Gerçek WhatsApp gönderimi ancak bağlantı kurulup test alıcısı belirlenerek yapılmalı.
