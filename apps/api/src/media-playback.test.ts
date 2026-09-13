import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@brixchat/database';
import type { ObjectStorageProvider } from '@brixchat/integrations';
import { registerMilestone5Routes } from './milestone5-routes';

function appForMedia() {
  const bytes = Buffer.from('OggS0123456789');
  const getObject = vi.fn(async () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
  const storage = { getObject, verify: (token:string) => token === 'valid' ? {key:'org/audio',exp:9999999999,downloadFilename:'voice.ogg'} : null } as unknown as ObjectStorageProvider;
  const sql = (async () => [{stored_mime_type:'audio/ogg'}]) as unknown as DatabaseClient;
  const app=Fastify();
  registerMilestone5Routes(app,sql,{authorize:()=>async()=>{},publish:async()=>{},storage,
    malwareScanner:{scan:async()=>({status:'clean'}),healthCheck:async()=>({healthy:true})},
    redisPing:async()=>'PONG',apiPublicUrl:'https://api.example.test'});
  return {app,getObject,bytes};
}
describe('signed playback response',()=>{
  it('serves real partial bytes with playback headers',async()=>{
    const {app,bytes}=appForMedia();
    try {
      const response=await app.inject({method:'GET',url:'/api/v1/media/object?token=valid',headers:{range:'bytes=4-7'}});
      expect(response.statusCode).toBe(206);
      expect(response.rawPayload).toEqual(bytes.subarray(4,8));
      expect(response.headers['content-type']).toContain('audio/ogg');
      expect(response.headers['content-range']).toBe(`bytes 4-7/${bytes.length}`);
      expect(response.headers['content-disposition']).toMatch(/^inline/);
      expect(response.headers['cache-control']).toBe('private, no-store');
    } finally {await app.close();}
  });
  it('returns full bytes and rejects invalid ranges',async()=>{
    const {app,bytes}=appForMedia();
    try {
      const full=await app.inject('/api/v1/media/object?token=valid');
      expect(full.statusCode).toBe(200); expect(full.rawPayload).toEqual(bytes);
      const download=await app.inject('/api/v1/media/object?token=valid&download=1');
      expect(download.headers['content-disposition']).toMatch(/^attachment/);
      const invalid=await app.inject({url:'/api/v1/media/object?token=valid',headers:{range:'bytes=999-'}});
      expect(invalid.statusCode).toBe(416); expect(invalid.headers['content-range']).toBe(`bytes */${bytes.length}`);
    } finally {await app.close();}
  });
  it('rejects invalid signatures before opening storage',async()=>{
    const {app,getObject}=appForMedia();
    try { expect((await app.inject('/api/v1/media/object?token=invalid')).statusCode).toBe(403); expect(getObject).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
});
