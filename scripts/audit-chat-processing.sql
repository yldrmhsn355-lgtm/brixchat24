BEGIN READ ONLY;
SELECT now() checked_at;
SELECT direction,type,status,count(*) total,
 count(*) FILTER(WHERE type='text' AND coalesce(body,'')='') empty_text
FROM messages GROUP BY 1,2,3 ORDER BY 1,2,3;
SELECT m.type,count(*) total,
 count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM message_attachments a WHERE a.message_id=m.id AND a.deleted_at IS NULL)) without_attachment
FROM messages m WHERE m.type IN('image','video','audio','document','sticker') GROUP BY 1;
SELECT attachment_type,processing_status,scan_status,coalesce(last_error_code,'-') error_code,count(*) total
FROM message_attachments WHERE deleted_at IS NULL GROUP BY 1,2,3,4 ORDER BY 1,2,3;
SELECT attachment_type,provider_mime_type,stored_mime_type,count(*) total
FROM message_attachments WHERE deleted_at IS NULL GROUP BY 1,2,3 ORDER BY 1,2;
SELECT status,coalesce(last_error,'-') error_code,count(*) total,min(created_at) oldest,max(updated_at) latest,max(attempt_count) attempts
FROM media_processing_jobs GROUP BY 1,2 ORDER BY 1,2;
SELECT status,count(*) total,min(created_at) oldest FROM outbox_jobs GROUP BY 1;
SELECT status,count(*) total,min(created_at) oldest,max(attempt_count) attempts FROM whatsapp_web_inbound_retries GROUP BY 1;
SELECT raw_type,reason,count(*) total FROM whatsapp_web_ignored_messages GROUP BY 1,2;
SELECT provider,connection_status,health_state,count(*) total FROM channels WHERE deleted_at IS NULL GROUP BY 1,2,3;
SELECT service,status,last_heartbeat,now()-last_heartbeat heartbeat_age FROM worker_instances ORDER BY last_heartbeat DESC LIMIT 1;
COMMIT;
