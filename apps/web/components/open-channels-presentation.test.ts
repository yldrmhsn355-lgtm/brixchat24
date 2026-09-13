import { describe, expect, it } from "vitest";
import {
  deriveOpenChannelStatus,
  filterOpenChannelItems,
  getDirectionLabel,
  getStatusCounts,
  type OpenChannelPresentationItem,
} from "./open-channels-presentation";

const items: OpenChannelPresentationItem[] = [
  {
    id: "active",
    connectionName: "BrixChat24 - Hasan",
    channelName: "WhatsApp 0894",
    lineName: "Satış Hattı",
    connectorId: "brixchat_connector_1",
    crmLabel: "Numara yoksa Lead oluştur",
    direction: "both",
    status: "active",
  },
  {
    id: "warning",
    connectionName: "English Support",
    channelName: "WhatsApp Support",
    lineName: "English Queue",
    connectorId: "brixchat_connector_2",
    crmLabel: "Yalnızca mevcut kayıt",
    direction: "incoming",
    status: "warning",
  },
  {
    id: "disabled",
    connectionName: "Dental Satış",
    channelName: "WhatsApp Dental",
    lineName: "Dental Queue",
    connectorId: "brixchat_connector_3",
    crmLabel: "Otomatik kayıt yok",
    direction: "none",
    status: "disabled",
  },
];

describe("Open Channels presentation", () => {
  it("normalizes provider state without relying on color-only labels", () => {
    expect(deriveOpenChannelStatus({ status: "active" })).toBe("active");
    expect(
      deriveOpenChannelStatus({
        open_channels_status: "registered",
        last_error: "provider unavailable",
      }),
    ).toBe("warning");
    expect(deriveOpenChannelStatus({ open_channels_status: "disabled" })).toBe(
      "disabled",
    );
    expect(deriveOpenChannelStatus(null)).toBe("warning");
  });

  it("combines settled search and status filters", () => {
    expect(filterOpenChannelItems(items, "english", "all")).toEqual([items[1]]);
    expect(filterOpenChannelItems(items, "whatsapp", "active")).toEqual([
      items[0],
    ]);
    expect(filterOpenChannelItems(items, "missing", "all")).toEqual([]);
  });

  it("derives tab counts from all loaded items", () => {
    expect(getStatusCounts(items)).toEqual({
      all: 3,
      active: 1,
      warning: 1,
      disabled: 1,
    });
  });

  it("describes every supported message direction", () => {
    expect(getDirectionLabel("both")).toBe("Çift yönlü");
    expect(getDirectionLabel("incoming")).toBe("Gelen mesajlar");
    expect(getDirectionLabel("outgoing")).toBe("Giden mesajlar");
    expect(getDirectionLabel("none")).toBe("Akış kapalı");
  });
});
