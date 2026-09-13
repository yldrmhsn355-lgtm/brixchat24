# ClamAV on this Windows server

Installed 10 September 2026: ClamAV 1.4.6 LTS, downloaded from the official ClamAV distribution. The ZIP SHA-256 was compared with the asset digest published by Cisco Talos on GitHub before extracting or executing it:

`57b6fd1d60cd87bafe800f97407ecdef0576d36b3900b8b7abcfbbabe88295fd`

Sources: <https://www.clamav.net/download> and <https://github.com/Cisco-Talos/clamav/releases/tag/clamav-1.4.6>.

- Runtime: `C:\ProgramData\Brixchat24\clamav\1.4.6` (executables, DLLs and configuration; build libraries/debug symbols were not extracted).
- Signatures: `C:\ProgramData\Brixchat24\clamav\database`.
- Temporary files: `C:\ProgramData\Brixchat24\clamav\tmp`.
- Logs: `C:\ProgramData\Brixchat24\logs\ClamAV`.
- Windows service: `Brixchat24-ClamAV`, automatic delayed start, WinSW restart after 15 seconds, `NT SERVICE\Brixchat24-ClamAV` identity.
- Listener: **127.0.0.1:3311**, not exposed through IIS or to the Internet.
- Resources: 2 scan threads, 20 queued scans, 25 MiB per file, 30 MiB input stream, 100 MiB expanded scan size, 30-second scan limit, concurrent signature reload disabled.
- Logs rotate at 10 MiB; WinSW retains 8 logs.
- `Brixchat24-ClamAV-Updates`: SYSTEM scheduled task every four hours; FreshClam validates downloaded signature databases. Task instances cannot overlap and have a 15-minute time limit.

Windows config paths use quoted backslashes. Forward slash paths were not accepted correctly by this build's database-directory checks.

`verify-clamav.mts` checks a real PING, scans harmless text as clean, and sends the standard harmless EICAR signature through INSTREAM as infected. It writes only the result to `logs\ClamAV\verification.json`; no EICAR upload is stored or sent to a customer.

The API and worker still have their media providers explicitly disabled. Do not enable the scanner environment variable alone: the current production adapter guard requires both supported private storage and ClamAV together. Storage setup and end-to-end upload/download acceptance remain separate work. Windows Defender remains enabled.
