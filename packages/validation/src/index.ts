import { z } from "zod";
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export const sendMessageSchema = z
  .object({
    clientMessageId: z.string().uuid(),
    channelId: z.string().uuid().optional(),
    type: z.literal("text").default("text"),
    text: z.string().trim().min(1).max(4096).optional(),
    body: z.string().trim().min(1).max(4096).optional(),
    replyToMessageId: z.string().min(1).max(200).optional(),
  })
  .refine((value) => Boolean(value.text ?? value.body), "text is required")
  .transform((value) => ({
    clientMessageId: value.clientMessageId,
    ...(value.channelId ? { channelId: value.channelId } : {}),
    type: value.type,
    text: value.text ?? value.body!,
    ...(value.replyToMessageId
      ? { replyToMessageId: value.replyToMessageId }
      : {}),
  }));
export const sendInteractiveMessageSchema = z.object({
  clientMessageId: z.string().uuid(),
  channelId: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(4096),
  interactive: z.record(z.string(), z.unknown()),
});
export const startConversationSchema = z.object({
  channelId: z.string().uuid(),
  phone: z.string().trim().min(8).max(32),
  displayName: z.string().trim().min(1).max(120).optional(),
});
export const conversationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  status: z
    .enum(["open", "waiting", "snoozed", "closed", "archived", "spam"])
    .optional(),
  assignee: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
  labelId: z.string().uuid().optional(),
  labelIdsAny: z
    .preprocess(
      (value) =>
        typeof value === "string"
          ? value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : value,
      z.array(z.string().uuid()).max(20),
    )
    .optional(),
  labelIdsAll: z
    .preprocess(
      (value) =>
        typeof value === "string"
          ? value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : value,
      z.array(z.string().uuid()).max(20),
    )
    .optional(),
  labelIdsNot: z
    .preprocess(
      (value) =>
        typeof value === "string"
          ? value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : value,
      z.array(z.string().uuid()).max(20),
    )
    .optional(),
  unlabeled: z.coerce.boolean().optional(),
  labelCategoryId: z.string().uuid().optional(),
  labeledAfter: z.string().datetime().optional(),
  labelSource: z
    .enum(["manual", "automation", "bitrix", "import", "system"])
    .optional(),
  whatsappOwnerUserId: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(),
  unreadOnly: z.coerce.boolean().optional(),
  excludeArchived: z.coerce.boolean().optional(),
  scope: z.enum(["all", "assigned_to_me", "unassigned"]).optional(),
});
export const inboxCountQuerySchema = z.object({
  channelId: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(),
});
export const messageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const organizationHeaderSchema = z.string().uuid();
