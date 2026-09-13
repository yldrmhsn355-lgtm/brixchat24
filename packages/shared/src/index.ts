export * from "./campaigns";
export type ConversationStatus = "open" | "waiting" | "closed";
export type MessageDirection = "inbound" | "outbound";
export type DeliveryStatus =
  "pending" | "sent" | "delivered" | "read" | "failed";

export interface ConversationSummary {
  id: string;
  organizationId: string;
  contactName: string;
  phone: string;
  avatar: string;
  preview: string;
  lastMessageAt: string;
  unreadCount: number;
  assigneeName: string | null;
  channelName: string;
  stage: string;
  priority: "low" | "normal" | "high";
  status: ConversationStatus;
  direction: MessageDirection;
  slaBreached: boolean;
  tags: string[];
}

export interface MessageView {
  id: string;
  conversationId: string;
  body: string;
  direction: MessageDirection;
  status: DeliveryStatus;
  sentAt: string;
  senderName: string;
}

export const demoConversations: ConversationSummary[] = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000001",
    contactName: "Elena Petrova",
    phone: "+44 7700 900123",
    avatar: "EP",
    preview: "Thank you, I can send the photos this evening.",
    lastMessageAt: "10:42",
    unreadCount: 2,
    assigneeName: "Ece Kaya",
    channelName: "Clinic Europe",
    stage: "Fotoğraf Bekleniyor",
    priority: "high",
    status: "open",
    direction: "inbound",
    slaBreached: true,
    tags: ["Implant", "EN"],
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    organizationId: "00000000-0000-4000-8000-000000000001",
    contactName: "Murat Demir",
    phone: "+90 532 555 0148",
    avatar: "MD",
    preview: "Transfer saatini teyit edebilir misiniz?",
    lastMessageAt: "10:18",
    unreadCount: 1,
    assigneeName: null,
    channelName: "Clinic TR",
    stage: "Uçuş Bekleniyor",
    priority: "normal",
    status: "open",
    direction: "inbound",
    slaBreached: false,
    tags: ["VIP"],
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    organizationId: "00000000-0000-4000-8000-000000000001",
    contactName: "Sofia Rossi",
    phone: "+39 320 555 0191",
    avatar: "SR",
    preview: "Your treatment plan is ready for review.",
    lastMessageAt: "Dün",
    unreadCount: 0,
    assigneeName: "Arda Yılmaz",
    channelName: "Clinic Europe",
    stage: "Teklif Gönderildi",
    priority: "normal",
    status: "waiting",
    direction: "outbound",
    slaBreached: false,
    tags: ["Veneers", "IT"],
  },
];

export const demoMessages: MessageView[] = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    conversationId: demoConversations[0]!.id,
    body: "Hello, I am interested in an implant treatment. Could you share the next steps?",
    direction: "inbound",
    status: "read",
    sentAt: "10:31",
    senderName: "Elena Petrova",
  },
  {
    id: "20000000-0000-4000-8000-000000000002",
    conversationId: demoConversations[0]!.id,
    body: "Of course. I can prepare a preliminary review after you send a panoramic X-ray and three clear photos.",
    direction: "outbound",
    status: "read",
    sentAt: "10:36",
    senderName: "Ece Kaya",
  },
  {
    id: "20000000-0000-4000-8000-000000000003",
    conversationId: demoConversations[0]!.id,
    body: "Thank you, I can send the photos this evening.",
    direction: "inbound",
    status: "delivered",
    sentAt: "10:42",
    senderName: "Elena Petrova",
  },
];
