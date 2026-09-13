'use client';
import { useEffect, useState } from 'react';
import { apiJson } from '../../../lib/api';

export type SignedMedia = { url: string; expiresAt: string };
export const signedMediaRefreshAt = (value: SignedMedia, now: number) => {
  const expires = Date.parse(value.expiresAt);
  return Number.isFinite(expires) ? Math.max(now + 15_000, expires - 30_000) : now + 120_000;
};

// Only mounted conversation attachments are retained. Failed requests are retried
// at a bounded interval, including when a tab wakes after sleeping.
export function useMediaUrls(ids: string[], thumbnail = false): Record<string, string> {
  const signature = [...new Set(ids)].sort().join(',');
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const cache = new Map<string, { url: string; refreshAt: number }>();
    const wanted = signature ? signature.split(',') : [];
    setUrls({});
    const refresh = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      let changed = false;
      for (const id of wanted) {
        if (cancelled) break;
        if ((cache.get(id)?.refreshAt ?? 0) > Date.now()) continue;
        try {
          const result = await apiJson<{ data: SignedMedia }>(`/api/v1/attachments/${id}/${thumbnail ? 'thumbnail-url' : 'download-url'}`, thumbnail ? undefined : { method: 'POST' });
          cache.set(id, { url: result.data.url, refreshAt: signedMediaRefreshAt(result.data, Date.now()) });
          changed = true;
        } catch {
          const previous = cache.get(id);
          cache.set(id, { url: previous?.url ?? '', refreshAt: Date.now() + 30_000 });
        }
      }
      if (!cancelled && changed) setUrls(Object.fromEntries([...cache].filter(([,v]) => v.url).map(([id,v]) => [id,v.url])));
      inFlight = false;
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const wake = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', wake);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', wake); };
  }, [signature, thumbnail]);
  return urls;
}
