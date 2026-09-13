-- RLS controls row visibility. Composite foreign keys additionally prevent an
-- otherwise visible row from referencing another tenant's hidden parent ID.
-- Existing foreign keys retain their delete/update actions; this extra check
-- runs at commit, after CASCADE/SET NULL actions have completed.
DO $$
DECLARE relation record; index_name text; constraint_name text;
BEGIN
  FOR relation IN
    SELECT fk.conname,c.relname child_table,p.relname parent_table,
      ca.attname child_column,pa.attname parent_column
    FROM pg_constraint fk
    JOIN pg_class c ON c.oid=fk.conrelid
    JOIN pg_class p ON p.oid=fk.confrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute ca ON ca.attrelid=c.oid AND ca.attnum=fk.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid=p.oid AND pa.attnum=fk.confkey[1]
    WHERE fk.contype='f' AND n.nspname='public' AND array_length(fk.conkey,1)=1
      AND ca.attname<>'organization_id'
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped)
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=p.oid AND a.attname='organization_id' AND NOT a.attisdropped)
  LOOP
    index_name := 'tenant_ref_uq_' || substr(md5(relation.parent_table || '.' || relation.parent_column),1,16);
    constraint_name := 'tenant_ref_' || substr(md5(relation.child_table || '.' || relation.conname),1,16);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I(organization_id,%I)',index_name,relation.parent_table,relation.parent_column);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY(organization_id,%I) REFERENCES public.%I(organization_id,%I) DEFERRABLE INITIALLY DEFERRED NOT VALID',relation.child_table,constraint_name,relation.child_column,relation.parent_table,relation.parent_column);
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I',relation.child_table,constraint_name);
  END LOOP;
END $$;
