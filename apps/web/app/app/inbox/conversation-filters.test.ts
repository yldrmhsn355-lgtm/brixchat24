import { describe, expect, it } from "vitest";
import {
  activeConversationFilterCount,
  buildConversationQuery,
  DEFAULT_CONVERSATION_FILTERS,
  readConversationFilters,
  writeConversationFilters,
} from "./conversation-filters";

describe("conversation filters", () => {
  it("combines quick, status, channel and label filters", () => {
    const query = new URLSearchParams(
      buildConversationQuery({
        query: "Ayşe",
        cursor: "next-page",
        append: true,
        channelId: "10000000-0000-4000-8000-000000000001",
        sidebarScope: "all",
        filters: {
          assignment: "assigned_to_me",
          unreadOnly: true,
          status: "waiting",
          labelIds: [
            "52000000-0000-4000-8000-000000000001",
            "52000000-0000-4000-8000-000000000002",
          ],
          labelOperator: "all",
          unlabeled: false,
        },
      }),
    );

    expect(Object.fromEntries(query)).toMatchObject({
      limit: "50",
      search: "Ayşe",
      cursor: "next-page",
      channelId: "10000000-0000-4000-8000-000000000001",
      scope: "assigned_to_me",
      unreadOnly: "true",
      status: "waiting",
      excludeArchived: "true",
      labelIdsAll:
        "52000000-0000-4000-8000-000000000001,52000000-0000-4000-8000-000000000002",
    });
  });

  it("preserves archived conversations and supports sidebar shortcuts", () => {
    const query = new URLSearchParams(
      buildConversationQuery({
        query: "",
        cursor: null,
        append: false,
        channelId: "all",
        sidebarScope: "archived",
        filters: DEFAULT_CONVERSATION_FILTERS,
      }),
    );

    expect(query.get("status")).toBe("archived");
    expect(query.has("excludeArchived")).toBe(false);
  });

  it("reads, writes and counts active filters", () => {
    const filters = readConversationFilters(
      "?assignment=unassigned&unread=1&status=snoozed&labels=vip,lead&labelOp=not&unlabeled=1",
    );
    const params = new URLSearchParams("scope=all");
    writeConversationFilters(params, filters);

    expect(filters).toEqual({
      assignment: "unassigned",
      unreadOnly: true,
      status: "snoozed",
      labelIds: ["vip", "lead"],
      labelOperator: "not",
      unlabeled: true,
    });
    expect(params.toString()).toContain("assignment=unassigned");
    expect(activeConversationFilterCount(filters, "channel-1")).toBe(6);
  });
});
