# Sohbet medya düzeltmeleri — 12 Eylül 2026

## Uygulanan değişiklikler

- Mikrofon kayıtlarının MIME codec parametreleri normalize edilir; WebM ses yüklemesi kabul edilir. WhatsApp'a gönderim aşamasında WebM, FFmpeg ile Ogg/Opus'a dönüştürülür. Orijinal depolanmış dosya değiştirilmez. Dönüşüm yalnızca gerektiğinde çalışır; dış bağlantılar başlangıç koşulu değildir.
- Başarısız ses yüklemesinde kayıt önizlemesi korunur. Başarılı yüklemeden sonra liste yenilemesinin başarısız olması ikinci gönderime yol açacak bir yükleme hatası olarak değerlendirilmez. Kayıt iptal edildiğinde onstop olayı iptal edilen kaydı yeniden oluşturmaz.
- Gelen dosyalar file-type ile tanınır; beyan edilen türle eşleşmeyen ikili dosyalar reddedilir. UTF-8/UTF-16 metin ve CSV ayrı doğrulanır. ZIP arşivi otomatik olarak DOCX kabul edilmez. ClamAV taraması korunur.
- Gelen ses, video ve belge için ayrı MEDIA_MAX_AUDIO_BYTES, MEDIA_MAX_VIDEO_BYTES, MEDIA_MAX_DOCUMENT_BYTES sınırları kullanılır. Görsel sınırı ayrı kalır. Varsayılanlar ve fiziksel depolama üst sınırı 25 MiB; mevcut daha düşük yapılandırma değerleri korunur.
- Medya ve thumbnail URL'leri son kullanma zamanı izlenerek yenilenir; başarısız URL istekleri sınırlı aralıklarla tekrar denenir. Sohbet değişiminde önceki URL önbelleği bırakılır.
- Ses/video yükleme hataları görünür olur; URL yenilendiğinde oynatma konumu korunmaya çalışılır. Tarayıcıya/codec'e bağlı tüm oynatma davranışları gerçek cihazlarla henüz sınanmadı.
- İmzalı yerel medya route'u doğru ses/görsel/video Content-Type, private/no-store ve nosniff başlıkları, byte-range/206 ve geçersiz aralık için 416 sağlar. Dosya indir işlemi ayrıca attachment disposition zorlar. İmza doğrulaması dosya açılmadan önce yapılır.
- Başarılı medya işlemleri ve stored/clean devam akışı job.last_error alanını temizler. Önceden completed olmuş bir kayıttaki tarihî hata alanına dokunulmadı; o ek zaten clean durumunda.

## Doğrulama

78 farklı hedefli test geçti: formatlar 12, gerçek sentetik WebM → Ogg dönüşümü 3, filesystem/ClamAV 17, API medya/readiness 25, web bileşen/indirme/URL yenileme 11, worker güvenli işleme/indirme kaynağı 10. API/Worker TypeScript kontrolleri ve Next üretim derlemesi geçti. İlk yoğun paralel test koşusunda zaman aşımı görüldü; tek worker ile tekrar koşum geçti. Ogg MIME codec varyantını ortaya çıkaran gerçek dönüşüm testi sonrası normalizasyon düzeltildi ve yeniden doğrulandı.

Canlıda mevcut birer PDF, JPEG, WebP sticker ve Ogg ses için imzalı URL üzerinden 206/16 bayt yanıtı, MIME, Content-Range ve zorunlu indirme doğrulandı. Sonuç: artifacts/chat-media-live.json. Gerçek bir alıcıya test mesajı gönderilmedi; mikrofon erişimi kullanılmadı. Gerçek video örneği bulunmadığı için WhatsApp video teslimi doğrulanmış sayılmıyor.

Tek MEDIA_OBJECT_CLEANUP_FAILED görsel, tenant yetkili retry API'siyle yeniden işlendi ve 12 Eylül 11:14 PDT'de completed/stored/clean oldu. Son denetimde 30/30 dosya mevcut, boyut ve SHA-256 eşleşiyor; medya dead-letter, outbox ve inbound retry kuyruğu boş. WhatsApp ACTIVE/HEALTHY ve oturum connected.

## Yayın ve geri dönüş

İlk yayın, yeni runtime dizinine servis hesaplarının erişememesi nedeniyle geri alındı. Runtime dizinine yalnızca API ve Worker için RX verilip yeniden yayın yapıldı. Başarılı backend yayınının kaynak yedeği: C:/ProgramData/Brixchat24/backups/chat-media-20260912-111128. Önceki web derlemesi: C:/ProgramData/Brixchat24/releases/20260910-platform-admin/apps/web/.next-before-media-20260912-111128.

Üretimde file-type 21.3.4 ve ffmpeg-static 5.3.0 bağımlılıkları C:/ProgramData/Brixchat24/media-runtime-20260912 altında tutulur; integrations/node_modules içinden bu dizine bağlantı verilir. Sonraki standart kurulumlar için workspace package.json, lockfile ve pnpm allowBuilds güncellendi. Dağıtım betiği scripts/deploy-chat-media.ps1; sonraki yalnızca arayüz güncellemesi -WebOnly ile API/Worker yeniden başlatılmadan uygulanır.

Graphify CLI bu makinede bulunmadığından graphify update çalıştırılamadı; graphify-out/graph.json mevcut değil.

Son arayüz yayını da tamamlandı: yedek C:/ProgramData/Brixchat24/backups/chat-media-20260912-111525. Yayın sonrası dokuz değişen kaynak dosyasının hash'i ve Next BUILD_ID çalışma alanıyla eşleşti. Public Web/API ve Worker sağlık kontrolleri 200/core-ready döndü.

12 Eylül 22:45 PDT tamamlanma kontrolü: canlı kaynakların dokuzu ve BUILD_ID hâlâ eşleşiyor. Medya sayısı 35'e yükseldi (20 görsel, 9 ses, 3 PDF, 3 sticker); tamamı stored/clean, fiziksel dosyalar mevcut ve boyut/SHA-256 değerleri doğru. Medya dead-letter, outbox ve inbound retry kuyruğu boş. WhatsApp connected/ACTIVE/HEALTHY; Worker heartbeat bir saniyeden yeni. Web/API/Worker sağlık kontrolleri 200. Önceki completed kaydın tarihî MEDIA_SCAN_FAILED alanı aktif bir hata değildir; ek stored/clean olarak doğrulandı.
