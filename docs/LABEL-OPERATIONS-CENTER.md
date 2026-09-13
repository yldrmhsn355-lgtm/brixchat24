# Etiket Yönetim Merkezi

## Amaç ve sınır

Etiketler, WhatsApp konuşmalarını operasyonel olarak sınıflandırır. CRM pipeline
aşamaları veya Bitrix24 fırsat aşamaları değildir. Bu sürüm konuşma etiketlerini
kapsar; kişi etiketi oluşturmaz. Bitrix24 bağlantısı olmadan tüm yerel CRUD,
atama, filtreleme, otomasyon ve analitik işlevleri çalışır.

## Faz 0 bulguları

Önceki model yalnızca `name` ve `color` tutuyor, konuşma atamalarını sert
silme ile kaldırıyor ve listeleme sırasında kullanım sayısını tekrar
hesaplıyordu. Tek etiket filtresi, temel Inbox seçicisi ve yalnızca basit
`add_label` otomasyon aksiyonu vardı. Kapsam, kategori, sürüm, audit, realtime,
arşiv, dependency ve analitik kavramları bulunmuyordu.

Kararlar:

- Kaynak gerçekliği PostgreSQL'deki `conversation_labels` ve
  `conversation_label_assignments` tablolarıdır.
- Kapsamlar `workspace`, `team`, `channel`; kişisel etiket yoktur.
- Kategoriler `multiple` veya `single` seçim moduna sahiptir.
- Silme soft-delete'dir. Kullanılan, otomasyona veya Bitrix eşlemesine bağlı
  etiket silinmez; arşivlenir ya da başka etikete birleştirilir.
- Üretim ortamına örnek etiket seed edilmez.

## Yetki matrisi

| Rol         | Görüntüle       | Ata/kaldır | Takım/kanal oluştur | Workspace oluştur | Güncelle/arşivle | Birleştir/toplu | Sil/kategori/eşleme |
| ----------- | --------------- | ---------- | ------------------- | ----------------- | ---------------- | --------------- | ------------------- |
| Owner/Admin | Evet            | Evet       | Evet                | Evet              | Evet             | Evet            | Evet                |
| Team lead   | Eriştiği kapsam | Evet       | Eriştiği kapsam     | Hayır             | Eriştiği kapsam  | Evet            | Hayır               |
| Agent       | Eriştiği kapsam | Evet       | Hayır               | Hayır             | Hayır            | Hayır           | Hayır               |
| Viewer      | Eriştiği kapsam | Hayır      | Hayır               | Hayır             | Hayır            | Hayır           | Hayır               |

API her istekte organizasyon ve kapsam erişimini yeniden doğrular. UI kontrolleri
tek başına güvenlik sınırı değildir.

## Veri yaşam döngüsü

- Adlar Türkçe locale ile normalize edilir; gereksiz boşluk ve harf farkları
  benzersizlik kuralını aşamaz.
- Güncellemeler `version` alanıyla optimistic concurrency kullanır.
- Arşivlenmiş etiket yeni atamalara kapalıdır; geçmiş atamalar korunur.
- Birleştirme konuşma atamalarını, otomasyon aksiyonlarını, favorileri ve Bitrix
  eşlemelerini hedef etikete taşır; kaynak `merged` olur.
- Atama kaynakları `manual`, `automation`, `bitrix`, `system` olarak saklanır.
- Süreli otomasyon atamaları worker tarafından kaldırılır.
- Kullanım sayısı atama trigger'ı ile atomik güncellenir; liste ekranında satır
  başına COUNT çalıştırılmaz.

## API özeti

- `GET/POST /api/v1/labels`
- `GET/PATCH/DELETE /api/v1/labels/:id`
- `POST /api/v1/labels/:id/archive|restore|duplicate|merge`
- `GET /api/v1/labels/:id/dependencies|analytics|audit|realtime`
- `GET/POST /api/v1/label-categories`
- `POST /api/v1/labels/bulk/conversations`
- `GET /api/v1/label-bulk-jobs/:id`
- `GET/POST /api/v1/labels/:id/mappings`
- `POST/DELETE /api/v1/conversations/:id/labels/:labelId`

## Inbox ve otomasyon

Inbox kartları en fazla üç renkli etiket ve kalan adet rozetini gösterir.
Filtreler `ANY`, `ALL`, `NOT` ve etiketsiz konuşmaları destekler. Konuşma
detayında etiket ekleme/kaldırma gerçek API'yi kullanır. `single` kategoride
yeni atama, aynı kategorideki önceki etiketi kontrollü biçimde değiştirir.

Otomasyonlarda `label_added` ve `label_removed` tetikleyicileri ile `add_label`
ve `remove_label` aksiyonları bulunur. `add_label` isteğe bağlı sona erme süresi
alır. Üretilen olaylar correlation ID, origin ve depth taşır; worker maksimum
derinlik ve aksiyon limitlerini uygular.

## Bitrix24 hazırlığı

Eşleme tablosu entity, field, value, yön, conflict policy, correlation ve son
senkronizasyon alanlarını tutar. Bu sürüm Bitrix24 bağlantısını veya erişim
bilgilerini zorunlu kılmaz. Harici senkronizasyon etkinleştirilmeden yerel etiket
işlemleri engellenmez.

## Operasyon ve geri dönüş

1. Veritabanı yedeğini doğrula.
2. `0013_label_operations_center.sql` migrasyonunu uygula.
3. API, web ve worker sürümlerini aynı release commit'inden yayınla.
4. Health, CRUD, Inbox atama/filtre ve worker bulk/expiry smoke testlerini çalıştır.
5. Sorunda uygulama sürümünü önceki commit'e döndür. Migrasyon geriye uyumlu
   kolonlar eklediği için veri tabanı kolonlarını aceleyle düşürme.

Etiket verisini geri almak gerekirse önce `label_usage_events`, audit ve atama
tablolarını dışa aktar. Birleştirilmiş kaynaklar `merged_into_id` ile izlenebilir.
