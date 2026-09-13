import { fileTypeFromBuffer } from 'file-type';
import { mimeAllowed, normalizeMediaMime } from './index';

export async function detectMediaMime(bytes: Uint8Array, declaration: string): Promise<string> {
  const declared = normalizeMediaMime(declaration);
  if (!mimeAllowed(declared)) throw new Error('MEDIA_SIGNATURE_DENIED');
  let detected: string | undefined;
  try { const result = await fileTypeFromBuffer(bytes); detected = result ? normalizeMediaMime(result.mime) : undefined; }
  catch { throw new Error('MEDIA_SIGNATURE_DENIED'); }
  if (!detected && ['text/plain', 'text/csv'].includes(declared)) {
    try {
      const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      const text = new TextDecoder(utf16, { fatal: true }).decode(bytes);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error();
      return declared;
    } catch { throw new Error('MEDIA_SIGNATURE_DENIED'); }
  }
  if (detected === declared) return declared;
  if ((detected === 'audio/opus' || detected === 'application/ogg') && ['audio/ogg','audio/opus'].includes(declared)) return 'audio/ogg';
  if (detected === 'audio/x-m4a' && declared === 'audio/mp4') return declared;
  if (detected === 'video/webm' && declared === 'audio/webm') return declared;
  if (detected === 'application/x-cfb' && ['application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint'].includes(declared)) return declared;
  throw new Error('MEDIA_SIGNATURE_DENIED');
}

export function mediaLimitBytes(mime: string, env: Record<string, string | undefined>): number {
  const family = normalizeMediaMime(mime).split('/')[0];
  const key = family === 'image' ? 'MEDIA_MAX_IMAGE_BYTES' : family === 'audio'
    ? 'MEDIA_MAX_AUDIO_BYTES' : family === 'video' ? 'MEDIA_MAX_VIDEO_BYTES' : 'MEDIA_MAX_DOCUMENT_BYTES';
  const configured = Number(env[key] ?? 25 * 1024 * 1024);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 25 * 1024 * 1024) : 25 * 1024 * 1024;
}

export function mediaByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new Error('MEDIA_RANGE_INVALID');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw new Error('MEDIA_RANGE_INVALID');
  return { start, end };
}
