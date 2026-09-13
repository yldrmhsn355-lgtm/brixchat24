import { describe, expect, it } from 'vitest';
import { detectMediaMime, mediaByteRange, mediaLimitBytes } from './formats';
import { mimeAllowed } from './index';

describe('chat format validation', () => {
  it('normalizes codec parameters without admitting unsafe formats', () => {
    expect(mimeAllowed(' Audio/WebM;codecs=opus ')).toBe(true);
    expect(mimeAllowed('audio/ogg; codecs=opus')).toBe(true);
    expect(mimeAllowed('image/svg+xml')).toBe(false);
    expect(mimeAllowed('text/html')).toBe(false);
  });
  it('accepts text and CSV, rejects binary disguised as text', async () => {
    await expect(detectMediaMime(Buffer.from('Türkçe metin'), 'text/plain')).resolves.toBe('text/plain');
    await expect(detectMediaMime(Buffer.from('ad,sayi\nörnek,12'), 'text/csv')).resolves.toBe('text/csv');
    await expect(detectMediaMime(Buffer.from([0,1,2,255]), 'text/plain')).rejects.toThrow('MEDIA_SIGNATURE_DENIED');
    await expect(detectMediaMime(Buffer.from('%PDF-1.7\n'), 'text/plain')).rejects.toThrow('MEDIA_SIGNATURE_DENIED');
  });
  it('recognizes GIF and PDF and rejects a MIME mismatch', async () => {
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
    await expect(detectMediaMime(gif, 'image/gif')).resolves.toBe('image/gif');
    await expect(detectMediaMime(gif, 'image/png')).rejects.toThrow('MEDIA_SIGNATURE_DENIED');
    await expect(detectMediaMime(Buffer.from('%PDF-1.7\n'), 'application/pdf')).resolves.toBe('application/pdf');
  });
  it('does not mistake an arbitrary ZIP for a Word document', async () => {
    await expect(detectMediaMime(Buffer.from('504b0506000000000000000000000000000000000000','hex'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).rejects.toThrow('MEDIA_SIGNATURE_DENIED');
  });
  it('uses independent limits and caps at physical storage capacity', () => {
    expect(mediaLimitBytes('audio/ogg', { MEDIA_MAX_IMAGE_BYTES: '10' })).toBe(25*1024*1024);
    expect(mediaLimitBytes('video/mp4', { MEDIA_MAX_VIDEO_BYTES: '100' })).toBe(100);
    expect(mediaLimitBytes('application/pdf', { MEDIA_MAX_DOCUMENT_BYTES: '999999999' })).toBe(25*1024*1024);
  });
});
describe('media byte ranges', () => {
  it('supports normal, open, suffix and oversized end ranges', () => {
    expect(mediaByteRange(undefined,10)).toBeNull();
    expect(mediaByteRange('bytes=2-4',10)).toEqual({start:2,end:4});
    expect(mediaByteRange('bytes=2-',10)).toEqual({start:2,end:9});
    expect(mediaByteRange('bytes=-3',10)).toEqual({start:7,end:9});
    expect(mediaByteRange('bytes=0-999',10)).toEqual({start:0,end:9});
  });
  it.each(['bytes=10-','bytes=8-2','bytes=-0','bytes=-','bytes=0-1,4-5','items=0-2'])('rejects invalid range %s', value => {
    expect(() => mediaByteRange(value,10)).toThrow('MEDIA_RANGE_INVALID');
  });
});
