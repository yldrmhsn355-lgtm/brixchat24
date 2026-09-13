# Windows IIS yerel kurulum

Adres: http://localhost:8080/login

IIS Manager > Sites > **Brixchat24**. Site dosyalari `C:\inetpub\Brixchat24` altindadir;
yalnizca reverse proxy yapilandirmasi sunulur, proje ve .env dosyalari sunulmaz.
IPv4 ve IPv6 loopback baglantilari kullanilir. Internet yayini/HTTPS kurulumu degildir.

Demo giris: `owner@brixchat.local` / `BrixChatDemo!2026`.
API yerel gelistirme modundadir; WhatsApp fake provider kullanir.
Web optimize edilmis Next.js build ile calisir.

## Calisan bilesenler

- IIS: Brixchat24 sitesi / Brixchat24 application pool, 8080.
- Windows Service: `Brixchat24-PostgreSQL`, otomatik baslar, 127.0.0.1:5434.
- Task Scheduler: `Brixchat24-Runtime`, SYSTEM hesabi, sistem acilisinda baslar.
  `supervisor.mjs` web (3300), API (4400), worker (4100) ve Redis (6381)
  sureclerini izler; kapanan sureci 5 saniye sonra yeniden baslatir.
- Veriler ve loglar: `C:\ProgramData\Brixchat24`.
- Ortam ayarlari ve rastgele yerel sirlar: proje kokundeki `.env.iis` (gitignore).
- PostgreSQL 17.11 EDB Windows binaries; Redis 7.4.9 redis-windows Cygwin portu.
  Indirilen arsivler `C:\ProgramData\Brixchat24\downloads` altindadir.

IIS ARR proxy ayarlari sunucu duzeyindedir. Degisiklik oncesi yedek:
`Brixchat24-before-setup`. Diger sitelerde proxy kullanimi eklenirse bu ortak
ayarlari dikkate alin. X-Forwarded-For port ekleme kapatilmistir; SSE icin
yanit buffering kapatilmistir.
Yerel kurulumda `TRUST_PROXY=false` kullanilir; istek IP adresi loopback olarak
kaydedilir. ARR'nin IPv6 adreslerini koseli parantezle iletmesi PostgreSQL inet
alanlariyla uyumlu degildir. Dis erisim icin istemci IP normalizasyonu ayrica ele alinmalidir.

## Guncelleme ve yonetim

Yonetici PowerShell, proje kokunde (Node.js ve pnpm PATH uzerinde):

```powershell
Stop-ScheduledTask -TaskName Brixchat24-Runtime
pnpm install --frozen-lockfile
node --env-file=.env.iis --import tsx packages/database/src/migrate.ts
node deploy/iis/build-web.mjs
Start-ScheduledTask -TaskName Brixchat24-Runtime
```

Build/migration basarisizsa hatayi duzeltmeden baslatmayin. Veritabanini yeniden
seed etmek guncelleme icin gerekli degildir. Proje veya Node.js konumu degisirse
Task Scheduler eylemindeki yollar da guncellenmelidir.

```powershell
Get-ScheduledTask -TaskName Brixchat24-Runtime
Get-Service Brixchat24-PostgreSQL
Get-Content C:\ProgramData\Brixchat24\logs\api.log -Tail 30
Invoke-RestMethod http://localhost:8080/health
```

IIS site ayarini tekrar uygulamak icin `./deploy/iis/register-site.ps1` kullanilir.
Graphify bu makinede kurulu olmadigindan `graphify update .` calistirilamadi.

Kaynaklar: [Microsoft IIS ARR](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/reverse-proxy-with-url-rewrite-v2-and-application-request-routing),
[PostgreSQL Windows](https://www.postgresql.org/download/windows/),
[Redis Windows portu](https://github.com/redis-windows/redis-windows/releases/tag/7.4.9).
