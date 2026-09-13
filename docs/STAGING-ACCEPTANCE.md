# Staging acceptance

Staging mirrors production topology with isolated credentials and test data. Required evidence: configuration report; HTTPS and security headers; Meta/Bitrix/storage/scanner/SMTP scenarios; RBAC and cross-tenant denial; migration and restore rehearsal; k6 smoke, standard, spike and soak; worker termination during active jobs; Redis/Postgres interruption recovery; horizontal worker duplicate-suppression; E2E; and synthetic checks. Redact all reports before retention.
