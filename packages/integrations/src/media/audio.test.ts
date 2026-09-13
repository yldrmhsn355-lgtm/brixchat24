import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import { prepareWhatsAppAudio } from './audio';
import { detectMediaMime } from './formats';

describe('real WhatsApp audio conversion (synthetic tone only)', () => {
  it('converts a browser-compatible WebM/Opus recording into decodable Ogg/Opus', async () => {
    if (!ffmpegPath) throw new Error('Converter must be installed for this test');
    const webm = execFileSync(ffmpegPath!, ['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.2','-c:a','libopus','-f','webm','pipe:1'], { windowsHide:true });
    await expect(detectMediaMime(webm,'audio/webm;codecs=opus')).resolves.toBe('audio/webm');
    const result = await prepareWhatsAppAudio({ bytes:webm, mimeType:'audio/webm;codecs=opus',filename:'voice.webm' });
    expect(result.mimeType).toBe('audio/ogg');
    expect(result.filename).toBe('voice.ogg');
    await expect(detectMediaMime(result.bytes,'audio/ogg')).resolves.toBe('audio/ogg');
    expect(() => execFileSync(ffmpegPath!, ['-hide_banner','-loglevel','error','-i','pipe:0','-f','null','-'], { input:result.bytes,windowsHide:true })).not.toThrow();
  }, 30_000);
  it('preserves already compatible audio', async () => {
    const bytes=Buffer.from('unchanged');
    expect((await prepareWhatsAppAudio({bytes,mimeType:'audio/mpeg',filename:'a.mp3'})).bytes).toBe(bytes);
  });
  it('fails safely for a broken recording', async () => {
    await expect(prepareWhatsAppAudio({bytes:Buffer.from('invalid'),mimeType:'audio/webm',filename:'a.webm'})).rejects.toThrow('MEDIA_AUDIO_CONVERSION_FAILED');
  });
});
