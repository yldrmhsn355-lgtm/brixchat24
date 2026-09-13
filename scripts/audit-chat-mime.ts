// Synthetic headers only; no tenant data or network writes.
import { mimeAllowed, sniffMime } from '../packages/integrations/src/media/index';
const examples: Array<[string, Buffer]> = [
  ['audio/webm;codecs=opus', Buffer.from('1a45dfa3', 'hex')],
  ['audio/ogg;codecs=opus', Buffer.from('OggS')],
  ['audio/mpeg', Buffer.from('ID3')],
  ['image/gif', Buffer.from('GIF89a')],
  ['text/plain', Buffer.from('hello')],
  ['text/csv', Buffer.from('a,b\n1,2')],
  ['application/msword', Buffer.from('d0cf11e0a1b11ae1', 'hex')],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('504b0304', 'hex')],
  ['video/webm', Buffer.from('1a45dfa3', 'hex')],
  ['application/pdf', Buffer.from('%PDF-1.7')],
];
console.log(JSON.stringify(examples.map(([mime, bytes]) => ({
  mime, uploadAllowed: mimeAllowed(mime),
  inboundDeclaredAllowed: mimeAllowed(mime.split(';')[0]!),
  detected: sniffMime(bytes) ?? null,
})), null, 2));
