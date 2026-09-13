ALTER TABLE crm_entity_links
  DROP CONSTRAINT IF EXISTS crm_entity_links_connection_id_entity_type_external_id_key;

DROP INDEX IF EXISTS crm_entity_link_external_uq;
