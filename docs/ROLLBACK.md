# Rollback

Stop promotion, capture current version and metrics, and switch traffic to the last verified immutable image. Additive migrations are not automatically reversed; deploy a forward fix unless an independently reviewed down migration and verified backup exist. Re-run smoke tests and verify queues before reopening traffic. Record decision, timestamps and data impact.
