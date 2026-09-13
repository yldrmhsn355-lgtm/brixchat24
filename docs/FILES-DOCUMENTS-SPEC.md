# Dosyalar ve Belgeler — Teknik Spesifikasyon

## Metadata

**Author:** Codex

**Date:** 2026-08-01

**Status:** Approved

**Reviewer:** Ürün sahibi (uygulama isteği ve ara onay beklememe talimatı)

**Target:** Brixchat24 çok kiracılı SaaS

## Context

Brixchat24 bugün WhatsApp inbound/outbound eklerini `message_attachments`,
`media_processing_jobs`, provider-neutral nesne depolama ve zararlı yazılım taramasıyla
işler. Dosyalar konuşma ekleri olarak güçlü biçimde desteklenir; ancak kişiler,
kanallar, tedavi bağlamları, otomasyonlar ve harici depolama hesapları arasında
bağımsız bir belge alanı yoktur.

Bu özellik mevcut medya hattını değiştirmeden onun üzerine tenant-izoleli bir
`file_assets` domain'i kurar. Güvenli ingest kopyası Drive kesintilerinde kaybı
önlemek için mevcut nesne deposunda kalabilir; Google Drive ilk kalıcı harici
provider'dır. Domain, API ve UI Google SDK'sına değil `StorageProvider` sözleşmesine
bağlanır.

## Functional Requirements

- FR-1: Sistem storage connection, file asset, contact folder, version, sync channel,
  OAuth state ve file audit kayıtlarını tenant-scoped tablolarla MUST saklamalıdır.
- FR-2: Aynı `(organization_id, whatsapp_message_id, provider_media_id)` girdisi
  MUST tek aktif file asset üretmelidir; checksum dedupe kişi ve tenant sınırını
  aşmamalıdır.
- FR-3: Domain MUST provider registry üzerinden çalışmalı; UI/API Google Drive
  istemcisini doğrudan çağırmamalıdır.
- FR-4: Google Drive adapter upload, resumable upload, streaming download, metadata,
  list, folder, move, rename, archive, trash, restore, share ve revoke işlemlerini
  MUST desteklemelidir.
- FR-5: OAuth authorization-code akışı offline access, dar `drive.file` scope,
  süreli/tek kullanımlık hash'lenmiş state, refresh token şifreleme, reconnect,
  disconnect ve health check MUST sağlamalıdır.
- FR-6: Inbound WhatsApp medya hattı webhook cevabını bekletmeden mevcut kalıcı iş
  tablosuna MUST bırakılmalı; tarama sonrası storage sync işi idempotent biçimde
  oluşturulmalıdır.
- FR-7: Drive arızasında güvenli ingest nesnesi ve retryable job MUST korunmalı;
  restart sonrası claim edilebilmelidir.
- FR-8: Kullanıcı bir file asset'i WhatsApp ile gönderdiğinde tenant/RBAC kontrolü,
  provider'dan stream indirme, mevcut güvenli nesne deposuna aktarma, tarama,
  `message_attachments` ve outbox oluşturma MUST atomik yürütülmelidir.
- FR-9: Dosya listesi backend arama, kategori, durum, kişi, kanal, connection,
  pagination ve soft-delete filtrelerini MUST desteklemelidir.
- FR-10: UI MUST responsive Dosyalar ve Belgeler sayfası, bağlantı yönetimi,
  upload/folder/search/filter/list-grid, arşiv/çöp ve gerçek backend aksiyonları sunmalıdır.
- FR-11: Inbox MUST kişi/conversation dosyalarını gösterebilmeli ve composer MUST
  bilgisayardan, Drive'dan veya hasta dosyalarından gerçek gönderim akışına bağlanmalıdır.
- FR-12: RBAC MUST `files.*` izinlerini backend'de uygulamalı; IDOR ve tenant kaçışı
  engellenmelidir.
- FR-13: Kritik dosya ve connection işlemleri MUST `file_audit_logs` kaydı üretmelidir.
- FR-14: Automation schema/runtime MUST dosya tetikleyici, koşul ve aksiyonlarını
  yalnızca gerçek yürütücü bulunan türler için kabul etmelidir.
- FR-15: Drive changes watch/list MUST channel token hash'i, page token, duplicate
  notification toleransı, expiration ve yenileme işini desteklemelidir.
- FR-16: Operasyon API/UI MUST connection, sync, retry, quarantine, orphan,
  duplicate ve süre metriklerini tenant-scope ile göstermelidir.
- FR-17: Özellik `GOOGLE_DRIVE_ENABLED` ile MUST kapatılabilmelidir.
- FR-18: Kullanıcı tarafından silme ilk aşamada MUST soft-delete/trash olmalı;
  restore desteklenmelidir.

## Non-Functional Requirements

- NFR-S1: Refresh/access token ve client secret hiçbir API cevabı veya logda MUST
  görünmemelidir; refresh token AES-GCM tabanlı mevcut `encryptSecret` ile şifrelenmelidir.
- NFR-S2: Her asset/connection sorgusu `organization_id` filtresi MUST içermelidir.
- NFR-S3: Upload MIME allowlist, magic-byte kontrolü, boyut sınırı ve malware scan
  olmadan READY durumuna geçmemelidir.
- NFR-R1: İşler `FOR UPDATE SKIP LOCKED`, lease timeout, bounded attempt ve
  exponential backoff ile restart-safe olmalıdır.
- NFR-R2: Webhook callback'leri 2 saniye içinde 2xx verecek şekilde yalnızca doğrulama
  ve enqueue yapmalıdır.
- NFR-P1: Liste API'si en fazla 100 satır döndürmeli ve tenant/status/category/date
  indekslerini kullanmalıdır.
- NFR-A1: Yeni UI keyboard kullanılabilir, görünür focus içeren ve mobile kırılımda
  tek kolon çalışan mevcut tasarım sistemiyle uyumlu olmalıdır.
- NFR-O1: Hatalar standart domain kodu ve correlation/trace id ile kaydedilmeli;
  kullanıcı mesajı secret veya ham provider cevabı içermemelidir.

## Acceptance Criteria

### AC-1: Webhook idempotency (FR-1, FR-2, FR-3)

Given aynı Meta medya webhook'u iki kez işlendiğinde, When
ikinci storage link işi çalıştığında, Then tek aktif `file_assets` satırı vardır.

### AC-2: Single-use OAuth state (FR-5, NFR-S1)

Given geçerli OAuth state, When callback bir kez tamamlanır,
Then connection oluşur ve state'in ikinci kullanımı 400 ile reddedilir.

### AC-3: Token refresh (FR-4, FR-5)

Given süresi dolmuş access token ve geçerli refresh token, When Drive
çağrısı yapılır, Then token backend'de yenilenir ve frontend'e verilmez.

### AC-4: Durable inbound retry (FR-6, FR-7, NFR-R1)

Given Drive geçici olarak erişilemez, When inbound medya
taranır, Then ingest kopyası korunur ve storage job retry olur.

### AC-5: Send asset through WhatsApp (FR-8)

Given kullanıcı erişebildiği READY asset'i seçer, When WhatsApp'a gönder
der, Then tek message, attachment ve outbox işi oluşur; Drive kopyası oluşmaz.

### AC-6: Tenant-isolated listing (FR-9, NFR-S2)

Given iki tenant'ta dosyalar vardır, When tenant A listeler veya
tenant B UUID'sini ister, Then yalnızca tenant A verisi döner/404 olur.

### AC-7: Connected UI actions (FR-10, FR-11, FR-17)

Given dosya sayfası veya Inbox açıktır, When gerçek bir aksiyon
seçilir, Then karşılık gelen backend isteği yapılır ve SSE sonrası durum güncellenir.

### AC-8: File authorization (FR-12)

Given izni olmayan kullanıcı, When download/share/delete ister, Then
403 döner ve provider çağrılmaz.

### AC-9: Audit trail (FR-13, FR-14)

Given yetkili kullanıcı ve geçerli bir dosya ya da connection vardır, When
upload/send/rename/move/share/archive/delete/restore veya connect/disconnect
tamamlanır, Then tenant-scope audit satırı oluşur.

### AC-10: Duplicate Drive notification (FR-15)

Given duplicate Drive notification, When changes.list işlenir, Then
aynı değişiklik ikinci kez domain durumunu bozmaz.

### AC-11: Soft delete and restore (FR-18)

Given aktif asset, When delete ve sonra restore yapılır, Then sırasıyla
çöp görünümünde ve aktif görünümde bulunur; aynı UUID korunur.

### AC-12: Unsafe upload rejection (FR-16, NFR-S3)

Given MIME spoofing, zararlı veya limit üstü dosya, When upload
yapılır, Then uygun domain hata koduyla reddedilir ve READY olmaz.

## Edge Cases

- EC-1: Google refresh token revoked -> `GOOGLE_TOKEN_REVOKED`, connection error.
- EC-2: Quota/429/5xx -> bounded retry; permission/404 -> permanent domain error.
- EC-3: Resumable session expires -> yeni session veya `UPLOAD_SESSION_EXPIRED` retry.
- EC-4: Aynı checksum farklı kişide -> ayrı asset; aynı kişi+connection içinde öneri.
- EC-5: Shared Drive işlemleri `supportsAllDrives`/`includeItemsFromAllDrives` kullanır.
- EC-6: Drive notification body boş olabilir; detay daima `changes.list` ile çekilir.
- EC-7: Disconnect credentials'ı kullanılamaz kılar; var olan file metadata korunur.
- EC-8: Rename/move provider'da başarılı DB'de başarısız olursa sync reconciliation düzeltir.
- EC-9: WhatsApp media ID kalıcı kabul edilmez; her outbound gerektiğinde yeniden upload edilir.

## API Contracts

Başarı cevabı `{ data: T, page?: { nextCursor?: string | null } }`, hata cevabı
`{ error: { code: string, message: string, correlationId?: string } }` biçimindedir.

```ts
interface StorageProvider {
  upload(input: UploadInput): Promise<StoredFile>;
  download(fileId: string): Promise<ReadableStream<Uint8Array>>;
  getMetadata(fileId: string): Promise<FileMetadata>;
  listFiles(input: ListFilesInput): Promise<FileMetadata[]>;
  createFolder(input: CreateFolderInput): Promise<Folder>;
  move(fileId: string, folderId: string): Promise<void>;
  rename(fileId: string, name: string): Promise<void>;
  archive(fileId: string): Promise<void>;
  delete(fileId: string): Promise<void>;
  restore(fileId: string): Promise<void>;
  createShareLink(input: ShareLinkInput): Promise<ShareLink>;
  revokeShareLink(permissionId: string): Promise<void>;
}
```

Connection endpoints: `GET auth-url`, `GET callback`, `GET connections`,
`GET connections/:id/health`, `PATCH connections/:id`, `POST reconnect`, `DELETE`.
File endpoints: list/create/upload/detail/rename/move/category/note/archive/delete/restore,
download-url/share/revoke/send-whatsapp, contact/conversation listing, sync/retry/health.
Webhook endpoint: `POST /webhooks/google-drive/:channelId`.

## Data Models

| Entity                  | Ana alanlar ve kısıtlar                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storage_connections     | organization FK, provider, encrypted credentials, scopes/config JSON, status/timestamps; org+id indexed                                                                                                                      |
| storage_oauth_states    | state_hash unique, org/user, expires/consumed; secret içermez                                                                                                                                                                |
| file_assets             | organization/provider/connection/provider IDs, contact/conversation/message/channel/treatment bağları, name/MIME/size/checksum/category/direction/source/status/visibility/metadata, soft-delete; idempotency partial unique |
| contact_storage_folders | org/contact/connection unique, provider_folder_id                                                                                                                                                                            |
| file_versions           | org/asset/version unique, checksum/size/provider ID                                                                                                                                                                          |
| storage_sync_channels   | org/connection/channel unique, token hash, page token/expiration/status                                                                                                                                                      |
| file_audit_logs         | org/asset/contact/user/action/metadata/IP/user-agent/timestamp                                                                                                                                                               |
| file_processing_jobs    | org/asset/job_type unique, durable status/attempt/lease/error                                                                                                                                                                |

## Out of Scope

- OS-1: OneDrive, Dropbox ve S3 document adapter implementasyonu bu sürümde yoktur; registry
  kontratı onlar için hazırdır.
- OS-2: Otomatik klinik/röntgen AI sınıflandırması yoktur; deterministik MIME/source/category
  sınıflandırması ve confidence alanı vardır.
- OS-3: Uygulamada bağımsız treatment-plan tablosu bulunmadığından `treatment_plan_id` nullable
  UUID olarak saklanır ve FK ancak domain mevcut olduğunda eklenir.
- OS-4: Google Cloud tenant'ı, OAuth consent screen, verified domain ve gerçek secret üretimi
  kodla yapılmaz.
- OS-5: Üretim migration/deploy, doğrulanmış backup kanıtı olmadan yapılmaz.

## Faz 0 kaynak haritası ve uygulama planı

- Mevcut medya: Meta/WA Web webhook -> `WorkerRepository.incoming` ->
  `message_attachments` + `media_processing_jobs` -> stream download -> MIME/size ->
  object storage -> malware scan -> stored/clean -> Redis/SSE.
- Outbound: API upload -> object storage + scan -> message/attachment/outbox -> provider.
- Tenant izolasyonu: `organization_id`, ownership checks ve `Permission` grant'leri.
- Queue: DB lease/claim/retry döngüsü restart-safe; BullMQ dependency mevcut ama runtime
  kullanılmıyor. Yeni işler aynı kalıcı pattern'i genişletecek.
- Inbox: `workspace.tsx`, `message-attachment.tsx`, upload ve drag/drop hazırdır.
- Automation: versioned trigger/condition/action tabloları, compiler ve worker runtime hazırdır.
- Realtime: Redis pub/sub + short-lived SSE token.
- Entegrasyon noktaları: integrations registry, storage route grubu, worker media completion,
  AppFrame/files page, Inbox contact panel, automation registry, operations page.
- Migration: `0019_files_documents.sql`; additive tablolar/indexler, mevcut tablo drop/rename yok.
- Başlıca riskler: token güvenliği, Drive kesintisi, cross-tenant IDOR, provider/DB split-brain,
  büyük stream'ler, sync channel spoofing ve mevcut migration/schema drift'i.
