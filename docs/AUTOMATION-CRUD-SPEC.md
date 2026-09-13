# Automation Management Lifecycle

## Metadata

**Author:** Codex
**Date:** 2026-07-30
**Status:** Approved
**Reviewer:** Product owner
**Approval basis:** Direct request to make the automation landing page a list and provide create, edit, and delete capabilities.

## Context

The automation navigation currently opens Automation Studio directly. This makes
the canvas behave like both a landing page and an unsaved draft, while existing
automations have no clear management surface.

The product needs a lifecycle-oriented entry point. Users must first see their
saved automations, then intentionally open a new canvas or edit an existing
automation. Removal must stop an automation without destroying its versions,
runs, or audit history.

## Functional Requirements

- FR-1: `/app/automations` MUST render a saved automation list and MUST NOT render a creation canvas.
- FR-2: The list MUST display name, status, last update time, and primary actions for every non-archived automation.
- FR-3: The page MUST provide an `Otomasyon ekle` action that navigates to `/app/automations/new`.
- FR-4: `/app/automations/new` MUST render an empty Automation Studio canvas.
- FR-5: Saving a new canvas MUST create an automation that appears on the management list.
- FR-6: Every listed automation MUST provide a `Düzenle` action that navigates to `/app/automations/:id`.
- FR-7: `/app/automations/:id` MUST load the selected automation draft into Automation Studio and save updates as a new draft version.
- FR-8: Every listed automation MUST provide a `Sil` action with an explicit confirmation step.
- FR-9: Confirmed deletion MUST archive the automation, stop it from appearing in the default list, and preserve versions and run history.
- FR-10: Cancelling deletion MUST make no API request and MUST leave the list unchanged.
- FR-11: The list MUST support client-side search by automation name or description and filtering by status.
- FR-12: Loading, empty, success, and error states MUST be visible and actionable.
- FR-13: Existing publish and run-history capabilities MUST remain accessible from the list.
- FR-14: The default automation list API MUST exclude archived automations.
- FR-15: The delete API MUST be tenant-scoped and permission-protected.

## Non-Functional Requirements

- NFR-1: List filtering SHOULD complete within 100 ms for up to 500 loaded automations.
- NFR-2: All management actions MUST be keyboard accessible and expose meaningful accessible names.
- NFR-3: Delete confirmation MUST use an accessible modal with `dialog` semantics.
- NFR-4: Delete MUST be recoverable at the database level because it uses archive semantics rather than physical deletion.
- NFR-5: API list and delete operations MUST enforce organization isolation.
- NFR-6: The change MUST NOT require a database migration.

## Acceptance Criteria

### AC-1: Management landing page (FR-1, FR-2)

Given a signed-in user opens `/app/automations`, when saved automations exist, then a management list is shown and no canvas is rendered.

### AC-2: New automation navigation (FR-3, FR-4)

Given the management list is open, when `Otomasyon ekle` is selected, then `/app/automations/new` opens with Automation Studio.

### AC-3: Created automation visibility (FR-5)

Given a valid new canvas is saved, when the user returns to the management list, then the new automation is present.

### AC-4: Edit existing automation (FR-6, FR-7)

Given a saved automation is listed, when `Düzenle` is selected, then its draft opens at `/app/automations/:id` and can be saved.

### AC-5: Cancel deletion (FR-8, FR-10, NFR-3)

Given `Sil` is selected, when the user cancels the confirmation, then the modal closes and the automation remains.

### AC-6: Confirm deletion (FR-8, FR-9, FR-14, FR-15)

Given deletion is confirmed, when the API succeeds, then the automation is archived and disappears from the default list.

### AC-7: Search and status filters (FR-11, NFR-1)

Given multiple automations exist, when search or status filters change, then only matching records are rendered without another API request.

### AC-8: Recoverable load failure (FR-12)

Given the list request fails, when the response is handled, then an error and retry action are displayed.

### AC-9: Row management actions (FR-13)

Given a draft automation is listed, when its actions are inspected, then publish, edit, run-history, and delete actions are available according to its state.

### AC-10: Archived records excluded (FR-14)

Given archived and active rules exist, when `GET /api/v1/automations` is called, then archived rules are absent.

### AC-11: Keyboard accessibility (FR-12, NFR-2)

Given keyboard navigation, when focus reaches management controls, then every action is operable and has a visible focus state.

## Edge Cases

- EC-1: Deleting an already archived or missing automation returns `404 automation_not_found`.
- EC-2: A user without `automations:update` cannot delete an automation.
- EC-3: A tenant cannot list, edit, or delete another tenant's automation.
- EC-4: An active automation may be archived; existing runs and versions remain queryable in storage.
- EC-5: An empty search result shows a filtered-empty state without replacing the create action.
- EC-6: API failure during deletion leaves the row visible and keeps the error available to the user.
- EC-7: Rapid repeated confirmation cannot issue concurrent delete requests.
- EC-8: Invalid or stale edit IDs render the existing API error without creating a replacement rule.

## API Contracts

```ts
interface AutomationSummary {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "paused";
  priority: number;
  draft_version: number;
  published_version: number | null;
  updated_at: string;
  last_run_at: string | null;
}

interface ListAutomationsResponse {
  data: AutomationSummary[];
}

// GET /api/v1/automations
// 200: ListAutomationsResponse

// DELETE /api/v1/automations/:id
interface DeleteAutomationResponse {
  data: {
    id: string;
    status: "archived";
  };
}

interface ApiError {
  error: {
    code: "automation_not_found" | "forbidden";
    message: string;
  };
}
```

## Data Models

| Entity | Field | Type | Constraints |
| --- | --- | --- | --- |
| automation_rules | id | uuid | Primary key |
| automation_rules | organization_id | uuid | Required tenant boundary |
| automation_rules | name | text | Required within active tenant scope |
| automation_rules | description | text nullable | Optional list subtitle |
| automation_rules | status | text | draft, active, paused, archived |
| automation_rules | draft_version | integer | Monotonic |
| automation_rules | published_version | integer nullable | Existing published version |
| automation_rules | updated_at | timestamptz | List ordering and display |
| automation_rule_versions | rule_id | uuid | Preserved after archive |
| automation_runs | rule_id | uuid | Preserved after archive |

No new table or column is required.

## Out of Scope

- OS-1: Hard deletion of automation rules, versions, or run history is excluded to protect auditability.
- OS-2: Bulk delete, bulk publish, import, and export are excluded.
- OS-3: Restoring archived automations is excluded from this slice.
- OS-4: Kanban view and collaborative real-time canvas editing are excluded.
- OS-5: Changes to automation execution semantics are excluded.
