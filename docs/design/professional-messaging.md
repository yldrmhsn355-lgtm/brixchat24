# Brixchat24 professional messaging UI

Approved direction: 2026-09-12. Reference: https://designmd.ai/chef/verdana-health-design-system

Use neutral surfaces and a restrained green action color. The reference informs visual principles; the palette and messaging adaptation below are specific to Brixchat24.

| Role | Light color |
| --- | --- |
| Canvas | #F6F7F5 |
| Surface | #FFFFFF |
| Primary text | #202824 |
| Secondary text | #626D67 |
| Action | #176B52 |
| Selected conversation | #E8F1EC |
| Outgoing message | #E2EFDF |
| Border | #DEE4DF |

Use Segoe UI Variable/system sans. Message text is 15px on desktop and 16px on mobile. Use 8–12px component corners, thin borders, and subtle elevation. Preserve semantic red/amber statuses; never use a decorative brand color to indicate an error.

The conversation list, conversation and optional details drawer remain the primary workflow. Preserve keyboard focus, accessible names, unread counts, delivery state, and the existing mobile navigation. Dark mode uses charcoal/green-gray surfaces and a softer green accent.

Shared overrides live in `apps/web/app/professional-theme.css`, imported after the legacy styles. Existing purple/indigo variable names are compatibility aliases, not separate brand colors. Legacy CSS literals in shared, campaign, template and platform styles were normalized to the new visual family.

Verification: production build and read-only Playwright navigation across inbox, campaigns, automations, AI, platform dashboard and login at 1440px, 820px and 390px; separate dark inbox capture. No outbound messages or tenant modifications are part of visual verification.

## Deployment verification, 2026-09-12

- Production build and TypeScript validation passed.
- Full local preview test passed: six routes, three viewports, dark inbox, page errors, horizontal overflow and light inbox name contrast.
- Production build ID and theme source hash match the verified workspace build.
- Public login, platform dashboard and API readiness returned HTTP 200; Web, API and Worker remained running.
- Public desktop navigation passed. The repeated full public test encountered rate limiting (HTTP 429), so it is not recorded as a complete public end-to-end pass. Public endpoints were checked again successfully afterwards.
- Previous web build: `C:/ProgramData/Brixchat24/releases/20260910-platform-admin/apps/web/.next-before-professional-20260912-065844`.
- Only the Web service was restarted. API and Worker were not redeployed.
- Graphify CLI was unavailable; graph input hygiene check passed.
