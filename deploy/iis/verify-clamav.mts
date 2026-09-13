import { writeFileSync } from "node:fs";
import { createMalwareScanner } from "../../packages/integrations/src/media/index";
const scanner=createMalwareScanner({ MALWARE_SCANNER_PROVIDER:"clamav", CLAMAV_HOST:"127.0.0.1", CLAMAV_PORT:"3311" });
const stream=(text:string)=>new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(text));controller.close();}});
const health=await scanner.healthCheck();
const clean=await scanner.scan({stream:stream("Brixchat24 harmless plain-text scanner check.")});
// Standard harmless EICAR test signature, sent in memory to INSTREAM; never saved as an upload.
const testSignature=String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-`+"STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const infected=await scanner.scan({stream:stream(testSignature)});
const result={checkedAt:new Date().toISOString(),healthy:health.healthy,clean:clean.status,testSignature:infected.status};
writeFileSync("C:/ProgramData/Brixchat24/logs/ClamAV/verification.json",JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
if(!health.healthy || clean.status!=="clean" || infected.status!=="infected")process.exitCode=1;
