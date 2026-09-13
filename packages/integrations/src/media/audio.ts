import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { normalizeMediaMime } from './index';

// Conversion is on demand; an absent converter never prevents application startup.
export async function prepareWhatsAppAudio(input: { bytes: Uint8Array; mimeType: string; filename: string }) {
  const mime = normalizeMediaMime(input.mimeType);
  if (mime !== 'audio/webm') return { ...input, mimeType: mime };
  const binary = process.env.FFMPEG_PATH || ffmpegPath;
  if (!binary) throw new Error('MEDIA_AUDIO_CONVERTER_UNAVAILABLE');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner','-loglevel','error','-nostdin',
      '-protocol_whitelist','pipe','-f','matroska','-i','pipe:0','-map','0:a:0',
      '-vn','-c:a','libopus','-b:a','32k','-ac','1','-ar','48000','-threads','1','-f','ogg','pipe:1'],
      { windowsHide: true, stdio: ['pipe','pipe','ignore'] });
    const chunks: Buffer[] = []; let size = 0; let failed = false;
    const fail = (code: string) => { if (failed) return; failed = true; child.kill(); reject(new Error(code)); };
    const timeout = setTimeout(() => fail('MEDIA_AUDIO_CONVERSION_TIMEOUT'), 60_000);
    child.on('error', () => fail('MEDIA_AUDIO_CONVERTER_UNAVAILABLE'));
    child.stdin.on('error', () => fail('MEDIA_AUDIO_CONVERSION_FAILED'));
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 25 * 1024 * 1024) fail('MEDIA_TOO_LARGE'); else chunks.push(chunk); });
    child.on('close', code => { clearTimeout(timeout); if (failed) return; if (code !== 0 || !size) reject(new Error('MEDIA_AUDIO_CONVERSION_FAILED')); else resolve(Buffer.concat(chunks)); });
    child.stdin.end(Buffer.from(input.bytes));
  });
  return { bytes, mimeType: 'audio/ogg', filename: input.filename.replace(/\.[^.]*$/, '') + '.ogg' };
}
