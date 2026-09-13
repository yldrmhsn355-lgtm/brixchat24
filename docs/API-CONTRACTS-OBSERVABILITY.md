# API Contracts and Runtime Observability

## OpenAPI contract

Set `OPENAPI_ENABLED=true` on the API service to expose the generated OpenAPI 3 document at `GET /openapi.json`. The endpoint is intended for internal contract discovery and client generation. Keep it behind the same private ingress or access policy as the API in production.

## Distributed rate limiting

Set `DISTRIBUTED_RATE_LIMIT_ENABLED=true` to store rate-limit counters in the API's Redis connection. All API replicas then share the `brixchat:rate-limit:` namespace instead of maintaining independent in-process counters.

Production validation reports a warning when this flag is disabled. Set `REQUIRE_DISTRIBUTED_RATE_LIMIT=true` to make the production configuration check fail closed. Enable both flags before horizontally scaling the API.

## Correlation and metrics

Every API response includes `X-Request-ID`. Existing request logs use the same identifier.

The protected `GET /metrics` endpoint includes these additional Prometheus counters:

- `brixchat_http_requests_total`
- `brixchat_http_request_duration_ms_sum`

Labels are limited to HTTP method, Fastify route template, and status class. Raw URLs, query strings, tenant identifiers, customer numbers, and message content are not emitted.

## Activation boundary

These features do not change provider registrations, webhook subscriptions, database credentials, or production infrastructure. Enabling the flags and verifying the production Redis/ingress behavior remains a deployment operation.
