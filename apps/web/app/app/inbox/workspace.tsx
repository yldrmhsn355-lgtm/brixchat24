"use client";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMediaUrls } from "./use-media-urls";
import { triggerAttachmentDownload } from "./attachment-download";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  ArrowDown,
  Check,
  CheckCheck,
  ChevronDown,
  Clock3,
  Copy,
  Filter,
  FileText,
  FolderOpen,
  HardDrive,
  Info,
  MessageCircleMore,
  Paperclip,
  Plus,
  Search,
  Send,
  Sparkles,
  Wifi,
  WifiOff,
  BookOpenText,
  Bot,
  MessagesSquare,
  Pin,
  BellOff,
  RefreshCw,
  RotateCcw,
  Mic,
  Play,
  Pause,
  Reply,
  Rows3,
  MapPin,
  MoreHorizontal,
  UserRound,
  Smile,
  Square,
  X,
} from "lucide-react";
import {
  ACCESS_TOKEN_CHANGED_EVENT,
  apiFetch,
  apiJson,
} from "../../../lib/api";
import { ContactAvatar } from "./contact-avatar";
import { isAttachmentDownloadable } from "./attachment-safety";
import { MessageAttachmentCard } from "./message-attachment";
import { formatAudioTime, shouldSubmitComposer } from "./message-presentation";
import {
  insertQuickReplyAtCursor,
  unresolvedVariables,
} from "../quick-replies/quick-reply-utils";
import { REACTION_EMOJIS } from "./reactions";
import {
  AI_STATE_LABELS,
  aiStateKind,
  formatConfidence,
  mapAiErrorMessage,
  shouldEmitEditedFeedback,
} from "./ai-reply";
import { canManageLabels, labelTextColor } from "../../../lib/labels";
import { useViewportMetrics } from "../../../hooks/use-viewport-metrics";
import { AppSidebar, MobileNavigation } from "../../../components/app-frame";
import { NotificationCenter } from "../../../components/notification-center";
import { WorkspaceSwitcher } from "../../../components/workspace-switcher";
import { ThemeToggle } from "../../../components/theme-toggle";
import {
  NewConversationDialog,
  type NewConversationChannel,
} from "./new-conversation-dialog";
import {
  conversationCardLabels,
  formatConversationTime,
  formatGroupParticipantPhone,
  formatMessageDay,
  groupParticipantCards,
  messageGroupPosition,
  messageDayKey,
  parseWhatsAppText,
  readStoredDrafts,
  reconcileLoadedMessages,
  shouldRenderMessageBody,
  messageDisplayBody,
  unreadBoundaryMessageId,
  visibleTimelineMessages,
} from "./inbox-presentation";

function WhatsAppFormattedText({ text }: { text: string }) {
  return parseWhatsAppText(text).map((segment, index) => {
    const key = `${segment.style}-${index}`;
    if (segment.style === "bold")
      return <strong key={key}>{segment.text}</strong>;
    if (segment.style === "italic") return <em key={key}>{segment.text}</em>;
    if (segment.style === "strike") return <del key={key}>{segment.text}</del>;
    if (segment.style === "code") return <code key={key}>{segment.text}</code>;
    return <Fragment key={key}>{segment.text}</Fragment>;
  });
}
import {
  activeConversationFilterCount,
  buildConversationQuery,
  DEFAULT_CONVERSATION_FILTERS,
  readConversationFilters,
  writeConversationFilters,
  type ConversationToolbarFilters,
} from "./conversation-filters";
type Conversation = {
  id: string;
  contactId: string;
  contactName: string;
  phone: string;
  isGroup: boolean;
  groupParticipants: Array<{
    jid: string;
    lid: string | null;
    phoneNumber: string | null;
    name: string | null;
    isAdmin: boolean;
  }>;
  avatar: string;
  profilePictureUrl: string | null;
  preview: string;
  lastMessageAt: string;
  unreadCount: number;
  assigneeId: string | null;
  assigneeName: string | null;
  channelName: string;
  whatsappOwnerName: string | null;
  whatsappPhone: string | null;
  channelId: string;
  stage: string;
  tags: string[];
  labels: Array<{
    id: string;
    name: string;
    color: string;
    icon: string | null;
  }>;
  status: string;
  direction: string;
  lastProviderStatus: string;
  customerServiceWindowExpiresAt: string | null;
};
type WhatsAppAccount = {
  userId: string;
  userName: string;
  channels: Array<{
    channelId: string;
    channelName: string;
    maskedPhoneNumber: string;
    status: string;
  }>;
  unreadConversationCount: number;
  openConversationCount: number;
};
type CurrentUser = { fullName: string; role: string };
type InboxCounts = {
  all: number;
  assignedToMe: number;
  unassigned: number;
  unread: number;
  archived: number;
};
type Assignee = {
  id: string;
  fullName: string;
  email: string;
  role: string;
};
type Message = {
  id: string;
  providerMessageId: string | null;
  conversationId: string;
  clientMessageId: string | null;
  body: string;
  type: string;
  direction: string;
  status: string;
  sentAt: string;
  senderName: string;
  metadata: Record<string, unknown>;
  attachments: Array<{
    id: string;
    type: string;
    filename: string;
    mimeType: string;
    status: string;
    scanStatus: string;
    size: number;
  }>;
  errorCode: string | null;
  errorMessage: string | null;
};
type RealtimeEvent = {
  eventId: string;
  eventType: string;
  conversationId?: string;
  payload: Record<string, unknown>;
};
type AiConversationState = {
  status: "active" | "paused" | "disabled" | null;
  paused_until: string | null;
  paused_reason: string | null;
  human_takeover_at: string | null;
  agent_id: string;
  agent_name: string;
  agent_status: string;
  agent_mode: string;
  agent_model: string;
} | null;
type AiSuggestionSummary = {
  id: string;
  decision: "suggested" | "draft_created" | "handoff";
  response_text: string | null;
  confidence: number | null;
  handoff_reason: string | null;
  started_at: string;
  final_text: string | null;
};
type QuickReply = {
  id: string;
  title: string;
  shortcut: string;
  content: string;
  language: string;
  scope: string;
  favorite: boolean;
  category_name: string | null;
};
type ConversationLabel = {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  scope?: "workspace" | "team" | "channel";
  favorite?: boolean;
  usage_count?: number;
};
type Template = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  body_text: string;
  variable_count: number;
};
type InboxFile = {
  id: string;
  sanitized_name: string;
  mime_type: string;
  category: string;
  status: string;
  size_bytes: number | null;
  created_at: string;
  message_id?: string | null;
  metadata?: {
    webViewLink?: string;
    internalNote?: string;
    treatmentRecordId?: string | null;
  };
};
type FileUploadStage =
  | "idle"
  | "downloading"
  | "validating"
  | "uploading"
  | "ready"
  | "failed"
  | "retrying";
type CrmData = {
  entity: { entityType: string; externalId: string; displayName: string };
  responsible: { name: string } | null;
  company: string | null;
  pipeline: string | null;
  stage: string | null;
  fields: Record<string, unknown>;
};
type CrmContext = {
  context: CrmData | null;
  fetchedAt: string | null;
  staleAt: string | null;
  stale: boolean;
  lastErrorCode: string | null;
  link: { entityType: string; externalId: string } | null;
} | null;

async function fetchCrmContext(conversationId: string) {
  return (
    await apiJson<{ data: CrmContext }>(
      `/api/v1/conversations/${conversationId}/crm-context`,
    )
  ).data;
}

async function fetchFreshCrmContext(conversationId: string) {
  const result = await apiJson<{
    data: { context: CrmData; fetchedAt: string };
  }>(`/api/v1/conversations/${conversationId}/crm-context/refresh`, {
    method: "POST",
  });
  return {
    context: result.data.context,
    fetchedAt: result.data.fetchedAt,
    staleAt: result.data.fetchedAt,
    stale: false,
    lastErrorCode: null,
    link: {
      entityType: result.data.context.entity.entityType,
      externalId: result.data.context.entity.externalId,
    },
  } satisfies NonNullable<CrmContext>;
}
type Note = {
  id: string;
  body: string;
  author_name: string;
  created_at: string;
  deleted_at: string | null;
};
type ConversationMenu = { id: string; x: number; y: number };
type MessageSearchResult = {
  id: string;
  conversationId: string;
  messageId: string;
  preview: string;
  occurredAt: string;
  highlights: Array<{ text: string; match: boolean }>;
};
// Empty means same-origin in production (Caddy proxies /api to the API).
// Explicit URLs remain supported for local development and split deployments.
const API = process.env.NEXT_PUBLIC_API_URL ?? "",
  REALTIME = process.env.NEXT_PUBLIC_REALTIME_URL ?? `${API}/api/v1/realtime`,
  DRAFT_STORAGE_KEY = "brixchat_inbox_drafts_v1",
  DENSITY_STORAGE_KEY = "brixchat_inbox_density_v1";
export function InboxWorkspace() {
  useViewportMetrics();
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [messages, setMessages] = useState<Message[]>([]),
    [messageCursor, setMessageCursor] = useState<string | null>(null),
    [conversationCursor, setConversationCursor] = useState<string | null>(null),
    [playingAudioId, setPlayingAudioId] = useState<string | null>(null),
    [reactionMessageId, setReactionMessageId] = useState<string | null>(null),
    [replyToMessage, setReplyToMessage] = useState<Message | null>(null),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [mobileChatOpen, setMobileChatOpen] = useState(false),
    [conversationMenu, setConversationMenu] = useState<ConversationMenu | null>(
      null,
    ),
    [newConversationOpen, setNewConversationOpen] = useState(false),
    [query, setQuery] = useState(""),
    [whatsappChannelId, setWhatsappChannelId] = useState(() => {
      if (typeof window === "undefined") return "all";
      return (
        new URLSearchParams(window.location.search).get("channel") ??
        localStorage.getItem("selected_whatsapp_channel_id") ??
        "all"
      );
    }),
    [filterScope, setFilterScope] = useState(() => {
      if (typeof window === "undefined") return "all";
      return new URLSearchParams(window.location.search).get("scope") ?? "all";
    }),
    [whatsappAccounts, setWhatsappAccounts] = useState<WhatsAppAccount[]>([]),
    [currentUserName, setCurrentUserName] = useState<string | null>(null),
    [currentUserRole, setCurrentUserRole] = useState<string | null>(null),
    [inboxCounts, setInboxCounts] = useState<InboxCounts>({
      all: 0,
      assignedToMe: 0,
      unassigned: 0,
      unread: 0,
      archived: 0,
    }),
    [assignees, setAssignees] = useState<Assignee[]>([]),
    [assignmentLoading, setAssignmentLoading] = useState(false),
    [drafts, setDrafts] = useState<Record<string, string>>(() =>
      typeof window === "undefined"
        ? {}
        : readStoredDrafts(localStorage.getItem(DRAFT_STORAGE_KEY)),
    ),
    [conversationDensity, setConversationDensity] = useState<
      "comfortable" | "compact"
    >(() =>
      typeof window !== "undefined" &&
      localStorage.getItem(DENSITY_STORAGE_KEY) === "compact"
        ? "compact"
        : "comfortable",
    ),
    [composerDragActive, setComposerDragActive] = useState(false),
    [composerToolsOpen, setComposerToolsOpen] = useState(false),
    [composerEmojiOpen, setComposerEmojiOpen] = useState(false),
    [copiedMessageId, setCopiedMessageId] = useState<string | null>(null),
    [interactiveMode, setInteractiveMode] = useState<
      "none" | "button" | "list"
    >("none"),
    [interactiveBody, setInteractiveBody] = useState(""),
    [interactiveOptions, setInteractiveOptions] = useState(""),
    [loading, setLoading] = useState(true),
    [channelSwitching, setChannelSwitching] = useState(false),
    [error, setError] = useState(""),
    [operationError, setOperationError] = useState(""),
    [quickReplies, setQuickReplies] = useState<QuickReply[]>([]),
    [quickMenuIndex, setQuickMenuIndex] = useState(0),
    [quickMenuForced, setQuickMenuForced] = useState(false),
    [composerCursor, setComposerCursor] = useState<number | null>(null),
    [selectedQuickReply, setSelectedQuickReply] = useState<{
      id: string;
      renderedContent: string;
      attachmentId: string | null;
    } | null>(null),
    [labels, setLabels] = useState<ConversationLabel[]>([]),
    [labelLoadError, setLabelLoadError] = useState(""),
    [labelActionError, setLabelActionError] = useState(""),
    [labelsOpen, setLabelsOpen] = useState(() => {
      if (typeof window === "undefined") return false;
      return Boolean(
        new URLSearchParams(window.location.search)
          .get("scope")
          ?.startsWith("label:"),
      );
    }),
    [newLabelOpen, setNewLabelOpen] = useState(false),
    [newLabelName, setNewLabelName] = useState(""),
    [newLabelColor, setNewLabelColor] = useState("#7c3aed"),
    [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]),
    [templates, setTemplates] = useState<Template[]>([]),
    [showTemplate, setShowTemplate] = useState(false),
    [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null),
    [templateVariables, setTemplateVariables] = useState<
      Record<string, string>
    >({}),
    [crmContext, setCrmContext] = useState<CrmContext>(null),
    [crmLoading, setCrmLoading] = useState(false),
    [crmLoadError, setCrmLoadError] = useState(""),
    [notes, setNotes] = useState<Note[]>([]),
    [noteDraft, setNoteDraft] = useState(""),
    [uploading, setUploading] = useState(false),
    [conversationFiles, setConversationFiles] = useState<InboxFile[]>([]),
    [filePickerOpen, setFilePickerOpen] = useState(false),
    [filePickerCategory, setFilePickerCategory] = useState("all"),
    [contactFileCategory, setContactFileCategory] = useState("all"),
    [pendingComposerFile, setPendingComposerFile] = useState<File | null>(null),
    [fileUploadStage, setFileUploadStage] = useState<FileUploadStage>("idle"),
    [voiceState, setVoiceState] = useState<
      "idle" | "recording" | "paused" | "preview"
    >("idle"),
    [voiceSeconds, setVoiceSeconds] = useState(0),
    [voiceBlob, setVoiceBlob] = useState<Blob | null>(null),
    [unreadAtOpen, setUnreadAtOpen] = useState(0),
    [nearBottom, setNearBottom] = useState(true),
    [newMessageCount, setNewMessageCount] = useState(0),
    [contactDetailsOpen, setContactDetailsOpen] = useState(false),
    [contactDrawerModal, setContactDrawerModal] = useState(false),
    [conversationSearchOpen, setConversationSearchOpen] = useState(false),
    [messageSearchQuery, setMessageSearchQuery] = useState(""),
    [messageSearchResults, setMessageSearchResults] = useState<
      MessageSearchResult[]
    >([]),
    [messageSearchLoading, setMessageSearchLoading] = useState(false),
    [activeSearchMessageId, setActiveSearchMessageId] = useState<string | null>(
      null,
    ),
    [conversationFilters, setConversationFilters] =
      useState<ConversationToolbarFilters>(() =>
        typeof window === "undefined"
          ? { ...DEFAULT_CONVERSATION_FILTERS }
          : readConversationFilters(window.location.search),
      ),
    [draftConversationFilters, setDraftConversationFilters] =
      useState<ConversationToolbarFilters>(() => ({
        ...DEFAULT_CONVERSATION_FILTERS,
      })),
    [draftChannelId, setDraftChannelId] = useState("all"),
    [filterMenuOpen, setFilterMenuOpen] = useState(false),
    [aiOverview, setAiOverview] = useState<{
      conversationId: string;
      state: AiConversationState;
    } | null>(null),
    [aiGenerating, setAiGenerating] = useState(false),
    [aiSuggestionState, setAiSuggestionState] = useState<{
      conversationId: string;
      runId: string;
      originalText: string;
      agentName: string;
      sources: Array<{ title: string; score: number }>;
    } | null>(null),
    [aiAgentOptions, setAiAgentOptions] = useState<
      Array<{ id: string; name: string }> | null
    >(null),
    [aiApprovalState, setAiApprovalState] = useState<{
      conversationId: string;
      runId: string;
      text: string;
      confidence: number | null;
      expanded: boolean;
    } | null>(null),
    [aiHandoffState, setAiHandoffState] = useState<{
      conversationId: string;
      runId: string;
      reason: string;
      suggestedText: string | null;
    } | null>(null),
    [connection, setConnection] = useState<
      "connected" | "reconnecting" | "offline"
    >("reconnecting");
  const [token, setToken] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("brixchat_access_token")
      : null,
  );
  const seen = useRef(new Set<string>()),
    aiDismissedRuns = useRef(new Set<string>()),
    fileInput = useRef<HTMLInputElement>(null),
    composerInput = useRef<HTMLTextAreaElement>(null),
    composerEmojiRef = useRef<HTMLDivElement>(null),
    contactPanelRef = useRef<HTMLElement>(null),
    messagesContainer = useRef<HTMLDivElement>(null),
    messageCursorRef = useRef<string | null>(null),
    conversationCursorRef = useRef<string | null>(null),
    conversationRequestRef = useRef<{
      id: number;
      controller: AbortController | null;
    }>({ id: 0, controller: null }),
    channelSwitchTargetRef = useRef<string | null>(null),
    preserveMessageScroll = useRef<{ height: number; top: number } | null>(
      null,
    ),
    scrollMessagesToLatest = useRef(true),
    nearBottomRef = useRef(true),
    recorder = useRef<MediaRecorder | null>(null),
    voiceStream = useRef<MediaStream | null>(null),
    voiceChunks = useRef<Blob[]>([]),
    labelMutationRef = useRef<Promise<void> | null>(null),
    filterMenuRef = useRef<HTMLDivElement>(null),
    newConversationTriggerRef = useRef<HTMLButtonElement>(null),
    authHeaders = useMemo(
      () => ({ authorization: `Bearer ${token ?? ""}` }),
      [token],
    ),
    selected = conversations.find((item) => item.id === selectedId) ?? null,
    draft = selectedId ? (drafts[selectedId] ?? "") : "",
    windowOpen = selected?.customerServiceWindowExpiresAt
      ? new Date(selected.customerServiceWindowExpiresAt) > new Date()
      : false,
    voiceSupported =
      typeof window === "undefined"
        ? null
        : typeof MediaRecorder !== "undefined" &&
          Boolean(navigator.mediaDevices?.getUserMedia),
    canManageLabelSettings = canManageLabels(currentUserRole),
    canAssignConversations = ["owner", "admin", "team_lead"].includes(
      currentUserRole ?? "",
    ),
    hasChannelAccess =
      currentUserRole !== "agent" || whatsappAccounts.length > 0,
    aiState =
      aiOverview && aiOverview.conversationId === selectedId
        ? aiOverview.state
        : null,
    aiSuggestion =
      aiSuggestionState && aiSuggestionState.conversationId === selectedId
        ? aiSuggestionState
        : null,
    aiApproval =
      aiApprovalState && aiApprovalState.conversationId === selectedId
        ? aiApprovalState
        : null,
    aiHandoff =
      aiHandoffState && aiHandoffState.conversationId === selectedId
        ? aiHandoffState
        : null,
    aiChipKind = aiStateKind(aiState);
  const newConversationChannels = useMemo<NewConversationChannel[]>(() => {
    const seenChannels = new Set<string>();
    return whatsappAccounts.flatMap((account) =>
      account.channels.flatMap((channel) => {
        if (seenChannels.has(channel.channelId)) return [];
        seenChannels.add(channel.channelId);
        return [
          {
            id: channel.channelId,
            label: `${channel.channelName} · ${channel.maskedPhoneNumber}`,
          },
        ];
      }),
    );
  }, [whatsappAccounts]);
  const canStartConversation =
    currentUserRole !== "viewer" && newConversationChannels.length > 0;
  function selectedChannelReadyForSend() {
    if (!selected || channelSwitching) return false;
    if (
      whatsappChannelId !== "all" &&
      selected.channelId !== whatsappChannelId
    ) {
      setOperationError(
        "Seçili WhatsApp hattı ile sohbet kanalı eşleşmiyor. Kanal geçişinin tamamlanmasını bekleyin.",
      );
      return false;
    }
    return true;
  }
  const timelineMessages = visibleTimelineMessages(messages),
    visibleGroupParticipants = selected?.isGroup
      ? groupParticipantCards(selected.groupParticipants, messages)
      : [],
    unreadBoundaryId = unreadBoundaryMessageId(timelineMessages, unreadAtOpen),
    activeFilterCount = activeConversationFilterCount(
      conversationFilters,
      whatsappChannelId,
    );
  const activeInboxLabel = filterScope.startsWith("label:")
    ? (labels.find((label) => `label:${label.id}` === filterScope)?.name ??
      "Etiket filtresi")
    : ({
        all: "Tüm konuşmalar",
        assigned_to_me: "Bana atanmış",
        unassigned: "Atanmamış",
        unread: "Okunmamış",
        archived: "Arşiv",
      }[filterScope] ?? "Filtrelenmiş görünüm");
  const voicePreviewUrl = useMemo(
    () => (voiceBlob ? URL.createObjectURL(voiceBlob) : null),
    [voiceBlob],
  );
  const quickMenuState = useMemo(() => {
    const cursor = composerCursor ?? draft.length;
    const beforeCursor = draft.slice(0, cursor);
    const slashIndex = beforeCursor.lastIndexOf("/");
    const slashActive =
      slashIndex >= 0 && !/\s/.test(beforeCursor.slice(slashIndex + 1));
    const query = slashActive
      ? beforeCursor.slice(slashIndex + 1).toLocaleLowerCase("tr")
      : "";
    const items = quickReplies
      .filter((reply) =>
        `${reply.shortcut} ${reply.title} ${reply.content} ${reply.category_name ?? ""}`
          .toLocaleLowerCase("tr")
          .includes(query),
      )
      .sort(
        (left, right) =>
          Number(right.favorite) - Number(left.favorite) ||
          left.shortcut.localeCompare(right.shortcut, "tr"),
      )
      .slice(0, 12);
    return {
      items,
      open: windowOpen && (quickMenuForced || slashActive),
    };
  }, [composerCursor, draft, quickMenuForced, quickReplies, windowOpen]);
  useEffect(
    () => () => {
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
    },
    [voicePreviewUrl],
  );
  useEffect(
    () => () =>
      voiceStream.current?.getTracks().forEach((track) => track.stop()),
    [],
  );
  useEffect(() => {
    const syncToken = () =>
      setToken(localStorage.getItem("brixchat_access_token"));
    window.addEventListener("storage", syncToken);
    window.addEventListener(ACCESS_TOKEN_CHANGED_EVENT, syncToken);
    return () => {
      window.removeEventListener("storage", syncToken);
      window.removeEventListener(ACCESS_TOKEN_CHANGED_EVENT, syncToken);
    };
  }, []);
  useEffect(() => {
    if (!composerEmojiOpen) return;
    composerEmojiRef.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus();
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !composerEmojiRef.current?.contains(event.target)
      )
        setComposerEmojiOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setComposerEmojiOpen(false);
      composerInput.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [composerEmojiOpen]);
  useEffect(() => {
    if (!filterMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !filterMenuRef.current?.contains(event.target)
      )
        setFilterMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterMenuOpen]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1500px)");
    const sync = () => setContactDrawerModal(media.matches);
    sync();
    media.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);
  useEffect(() => {
    if (!contactDetailsOpen || !contactDrawerModal) return;
    const panel = contactPanelRef.current;
    const returnFocus = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContactDetailsOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      returnFocus?.focus();
    };
  }, [contactDetailsOpen, contactDrawerModal]);
  useEffect(() => {
    if (voiceState !== "recording") return;
    const timer = window.setInterval(
      () => setVoiceSeconds((value) => value + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [voiceState]);
  useEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 52), 150)}px`;
  }, [draft]);
  useEffect(() => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  }, [drafts]);
  useEffect(() => {
    localStorage.setItem(DENSITY_STORAGE_KEY, conversationDensity);
  }, [conversationDensity]);
  useEffect(() => {
    if (!conversationSearchOpen || !selectedId) return;
    const q = messageSearchQuery.trim();
    if (q.length < 2) return;
    const timer = window.setTimeout(() => {
      setMessageSearchLoading(true);
      void apiJson<{ data: MessageSearchResult[] }>(
        `/api/v1/search?q=${encodeURIComponent(q)}&type=messages&conversationId=${selectedId}&limit=50`,
      )
        .then((result) => setMessageSearchResults(result.data))
        .catch(() => setMessageSearchResults([]))
        .finally(() => setMessageSearchLoading(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [conversationSearchOpen, messageSearchQuery, selectedId]);
  useEffect(() => {
    const handleInboxShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (
        selectedId &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLocaleLowerCase() === "f"
      ) {
        event.preventDefault();
        setConversationSearchOpen(true);
        return;
      }
      if (!isTyping && selectedId && event.key.toLocaleLowerCase() === "r") {
        event.preventDefault();
        composerInput.current?.focus();
        return;
      }
      if (!isTyping && selectedId && event.key === "/") {
        event.preventDefault();
        composerInput.current?.focus();
        setDrafts((current) => ({ ...current, [selectedId]: "/" }));
        return;
      }
      if (event.key === "Escape") {
        setConversationSearchOpen(false);
        setContactDetailsOpen(false);
        setReactionMessageId(null);
      }
    };
    window.addEventListener("keydown", handleInboxShortcut);
    return () => window.removeEventListener("keydown", handleInboxShortcut);
  }, [selectedId]);
  function setDraft(value: string) {
    if (!selectedId) return;
    setDrafts((current) => {
      if (!value) {
        const next = { ...current };
        delete next[selectedId];
        return next;
      }
      return { ...current, [selectedId]: value };
    });
  }
  function resetConversationUi() {
    nearBottomRef.current = true;
    setNearBottom(true);
    setNewMessageCount(0);
    setActiveSearchMessageId(null);
    setConversationSearchOpen(false);
    setMessageSearchQuery("");
    setMessageSearchResults([]);
    setMessageSearchLoading(false);
    setContactDetailsOpen(false);
    setQuickMenuForced(false);
    setQuickMenuIndex(0);
    setComposerCursor(null);
    setSelectedQuickReply(null);
  }
  function selectSidebarFilter(scope: string) {
    setConversationFilters({ ...DEFAULT_CONVERSATION_FILTERS });
    setFilterScope(scope);
  }
  function toggleConversationFilters() {
    setFilterMenuOpen((open) => {
      if (!open) {
        setDraftConversationFilters({ ...conversationFilters });
        setDraftChannelId(whatsappChannelId);
      }
      return !open;
    });
  }
  function applyConversationFilters() {
    setConversationFilters({ ...draftConversationFilters });
    setWhatsappChannelId(draftChannelId);
    setFilterScope("all");
    setFilterMenuOpen(false);
  }
  function clearConversationFilters() {
    const cleared = { ...DEFAULT_CONVERSATION_FILTERS };
    setConversationFilters(cleared);
    setDraftConversationFilters(cleared);
    setDraftChannelId("all");
    setWhatsappChannelId("all");
    setFilterScope("all");
    setFilterMenuOpen(false);
  }
  function selectConversation(item: Conversation) {
    resetConversationUi();
    setUnreadAtOpen(item.unreadCount);
    setSelectedId(item.id);
    setMobileChatOpen(true);
  }
  function scrollToLatest() {
    const container = messagesContainer.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    nearBottomRef.current = true;
    setNearBottom(true);
    setNewMessageCount(0);
  }
  async function copyMessage(message: Message) {
    const value = message.body.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopiedMessageId(message.id);
    window.setTimeout(
      () =>
        setCopiedMessageId((current) =>
          current === message.id ? null : current,
        ),
      1600,
    );
  }
  function handleMessagesScroll() {
    const container = messagesContainer.current;
    if (!container) return;
    const next =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      96;
    nearBottomRef.current = next;
    setNearBottom(next);
    if (next) setNewMessageCount(0);
  }
  const loadConversations = useCallback(
    async (append = false) => {
      if (!token) {
        window.location.href = "/login";
        return;
      }
      const requestId = conversationRequestRef.current.id + 1;
      conversationRequestRef.current.controller?.abort();
      const controller = new AbortController();
      conversationRequestRef.current = { id: requestId, controller };
      const requestedChannelId = whatsappChannelId;
      try {
        setError("");
        const params = buildConversationQuery({
          query,
          cursor: conversationCursorRef.current,
          append,
          channelId: whatsappChannelId,
          sidebarScope: filterScope,
          filters: conversationFilters,
        });
        const response = await fetch(`${API}/api/v1/conversations?${params}`, {
          headers: authHeaders,
          signal: controller.signal,
        });
        if (response.status === 401) {
          localStorage.removeItem("brixchat_access_token");
          window.location.href = "/login";
          return;
        }
        if (!response.ok) throw new Error("Konuşmalar yüklenemedi");
        const body = (await response.json()) as {
          data: Conversation[];
          page?: { nextCursor?: string | null };
        };
        if (conversationRequestRef.current.id !== requestId) return;
        const nextCursor = body.page?.nextCursor ?? null;
        conversationCursorRef.current = nextCursor;
        setConversationCursor(nextCursor);
        setConversations((current) => {
          if (!append) return body.data;
          const seen = new Set(current.map((item) => item.id));
          return [
            ...current,
            ...body.data.filter((item) => !seen.has(item.id)),
          ];
        });
        setSelectedId((current) => {
          if (append) return current ?? body.data[0]?.id ?? null;
          if (current && body.data.some((item) => item.id === current))
            return current;
          return body.data[0]?.id ?? null;
        });
        if (channelSwitchTargetRef.current === requestedChannelId) {
          channelSwitchTargetRef.current = null;
          setChannelSwitching(false);
        }
      } catch (reason) {
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (conversationRequestRef.current.id !== requestId) return;
        setError(reason instanceof Error ? reason.message : "Bağlantı hatası");
        if (channelSwitchTargetRef.current === requestedChannelId) {
          channelSwitchTargetRef.current = null;
          setConversations([]);
          setSelectedId(null);
          setChannelSwitching(false);
        }
      } finally {
        if (conversationRequestRef.current.id === requestId) {
          conversationRequestRef.current.controller = null;
          setLoading(false);
        }
      }
    },
    [
      authHeaders,
      conversationFilters,
      filterScope,
      query,
      token,
      whatsappChannelId,
    ],
  );
  const loadInboxCounts = useCallback(async () => {
    if (!token) return;
    try {
      const params = new URLSearchParams();
      if (query) params.set("search", query);
      if (whatsappChannelId !== "all")
        params.set("channelId", whatsappChannelId);
      const result = await apiJson<{ data: InboxCounts }>(
        `/api/v1/inbox/counts${params.size ? `?${params.toString()}` : ""}`,
      );
      setInboxCounts(result.data);
    } catch {
      setInboxCounts({
        all: 0,
        assignedToMe: 0,
        unassigned: 0,
        unread: 0,
        archived: 0,
      });
    }
  }, [query, token, whatsappChannelId]);
  const loadLabels = useCallback(async () => {
    setLabelLoadError("");
    try {
      const result = await apiJson<{ data: ConversationLabel[] }>(
        "/api/v1/labels",
      );
      setLabels(result.data ?? []);
    } catch (reason) {
      setLabels([]);
      setLabelLoadError(
        reason instanceof Error ? reason.message : "Etiketler yüklenemedi.",
      );
    }
  }, []);
  const loadAiState = useCallback(
    (conversationId: string) =>
      apiJson<{
        data: {
          state: AiConversationState;
          latestSuggestion: AiSuggestionSummary | null;
        };
      }>(`/api/v1/ai/conversations/${conversationId}`)
        .then((response) => {
          setAiOverview({ conversationId, state: response.data.state });
          const suggestion = response.data.latestSuggestion;
          const dismissed = suggestion
            ? aiDismissedRuns.current.has(suggestion.id)
            : true;
          const approval =
            suggestion &&
            !dismissed &&
            suggestion.decision === "draft_created" &&
            !suggestion.final_text &&
            suggestion.response_text
              ? {
                  conversationId,
                  runId: suggestion.id,
                  text: suggestion.response_text,
                  confidence: suggestion.confidence,
                }
              : null;
          setAiApprovalState((current) =>
            approval
              ? {
                  ...approval,
                  expanded:
                    current?.runId === approval.runId
                      ? current.expanded
                      : false,
                }
              : null,
          );
          setAiHandoffState(
            suggestion && !dismissed && suggestion.decision === "handoff"
              ? {
                  conversationId,
                  runId: suggestion.id,
                  reason: suggestion.handoff_reason ?? "",
                  suggestedText: suggestion.response_text,
                }
              : null,
          );
        })
        .catch(() => {
          setAiOverview(null);
        }),
    [],
  );
  useEffect(() => {
    if (selectedId) void loadAiState(selectedId);
  }, [selectedId, loadAiState]);
  useEffect(() => {
    const saved =
      typeof window !== "undefined"
        ? localStorage.getItem("selected_whatsapp_channel_id")
        : null;
    const urlChannel =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("channel")
        : null;
    if (!urlChannel && saved)
      void Promise.resolve().then(() => setWhatsappChannelId(saved));
    void apiJson<{ data: { accounts?: WhatsAppAccount[] } }>(
      "/api/v1/inbox/whatsapp-accounts",
    )
      .then((accounts) => {
        setWhatsappAccounts(accounts.data.accounts ?? []);
      })
      .catch(() => setWhatsappAccounts([]));
    void Promise.resolve().then(loadLabels);
    void apiJson<{ data: CurrentUser }>("/api/v1/auth/me")
      .then((currentUser) => {
        setCurrentUserName(currentUser.data.fullName);
        setCurrentUserRole(currentUser.data.role);
      })
      .catch(() => {
        setCurrentUserName(null);
        setCurrentUserRole(null);
      });
  }, [loadLabels]);
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("selected_whatsapp_channel_id", whatsappChannelId);
      const params = new URLSearchParams(window.location.search);
      if (whatsappChannelId === "all") params.delete("channel");
      else params.set("channel", whatsappChannelId);
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${params.toString()}`,
      );
    }
    void Promise.resolve().then(() => {
      nearBottomRef.current = true;
      setNearBottom(true);
      setNewMessageCount(0);
      setActiveSearchMessageId(null);
      setConversationSearchOpen(false);
      setMessageSearchQuery("");
      setMessageSearchResults([]);
      setMessageSearchLoading(false);
      setContactDetailsOpen(false);
      setUnreadAtOpen(0);
    });
  }, [whatsappChannelId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (filterScope === "all") params.delete("scope");
    else params.set("scope", filterScope);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`,
    );
  }, [filterScope]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    writeConversationFilters(params, conversationFilters);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`,
    );
  }, [conversationFilters]);
  useEffect(() => {
    conversationCursorRef.current = null;
    void Promise.resolve().then(() => setConversationCursor(null));
  }, [conversationFilters, filterScope, query, whatsappChannelId]);
  useEffect(
    () => () => {
      conversationRequestRef.current.controller?.abort();
      conversationRequestRef.current.id += 1;
    },
    [],
  );
  const loadMessages = useCallback(
    async (id: string, append = false) => {
      const container = messagesContainer.current;
      if (append && container)
        preserveMessageScroll.current = {
          height: container.scrollHeight,
          top: container.scrollTop,
        };
      scrollMessagesToLatest.current = !append && nearBottomRef.current;
      const response = await fetch(
        `${API}/api/v1/conversations/${id}/messages?limit=100${append && messageCursorRef.current ? `&cursor=${encodeURIComponent(messageCursorRef.current)}` : ""}`,
        { headers: authHeaders },
      );
      if (response.ok) {
        const body = (await response.json()) as {
          data: Message[];
          page?: { nextCursor?: string | null };
        };
        const nextCursor = body.page?.nextCursor ?? null;
        messageCursorRef.current = nextCursor;
        setMessageCursor(nextCursor);
        setMessages((current) => {
          if (!append) return reconcileLoadedMessages(body.data, current, id);
          const seen = new Set(current.map((message) => message.id));
          return [
            ...body.data.filter((message) => !seen.has(message.id)),
            ...current,
          ];
        });
      }
    },
    [authHeaders],
  );
  async function jumpToSearchResult(result: MessageSearchResult) {
    if (!selectedId || !result.messageId) return;
    const response = await apiJson<{
      data: { messages: Message[]; targetMessageId: string };
    }>(
      `/api/v1/conversations/${selectedId}/messages/around/${result.messageId}`,
    );
    scrollMessagesToLatest.current = false;
    nearBottomRef.current = false;
    setNearBottom(false);
    setMessages(response.data.messages);
    setMessageCursor(null);
    messageCursorRef.current = null;
    setActiveSearchMessageId(response.data.targetMessageId);
    window.requestAnimationFrame(() => {
      document
        .getElementById(`message-${response.data.targetMessageId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }
  useEffect(() => {
    const timer = setTimeout(
      () => void Promise.all([loadConversations(), loadInboxCounts()]),
      250,
    );
    return () => clearTimeout(timer);
  }, [loadConversations, loadInboxCounts]);
  useEffect(() => {
    if (!canAssignConversations) return;
    void apiJson<{ data: Assignee[] }>("/api/v1/inbox/assignees")
      .then((result) => setAssignees(result.data))
      .catch(() => setAssignees([]));
  }, [canAssignConversations]);
  useEffect(() => {
    if (!selectedId) return;
    void apiJson<{ data: Array<{ id: string }> }>(
      `/api/v1/conversations/${selectedId}/labels`,
    )
      .then((result) =>
        setSelectedLabelIds(result.data.map((label) => label.id)),
      )
      .catch(() => setSelectedLabelIds([]));
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    void Promise.resolve().then(() => {
      messageCursorRef.current = null;
      setMessageCursor(null);
      setMessages([]);
    });
    const timer = setTimeout(() => void loadMessages(selectedId), 0);
    return () => clearTimeout(timer);
  }, [loadMessages, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    void apiFetch(`/api/v1/conversations/${selectedId}/read`, {
      method: "POST",
    })
      .then(() => {
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === selectedId
              ? { ...conversation, unreadCount: 0 }
              : conversation,
          ),
        );
      })
      .catch(() => {
        // Message loading should remain usable if the provider read receipt
        // is temporarily unavailable; the next reconciliation retries it.
      });
  }, [selectedId]);
  useEffect(() => {
    if (!conversationMenu) return;
    const close = (event?: PointerEvent) => {
      if (
        event?.target instanceof Element &&
        event.target.closest(".conversation-context-menu")
      )
        return;
      if (!event || event.button === 0) setConversationMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const trigger = document.querySelector<HTMLButtonElement>(
          `[data-conversation-id="${CSS.escape(conversationMenu.id)}"]`,
        );
        close();
        window.requestAnimationFrame(() => trigger?.focus());
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [conversationMenu]);
  useEffect(() => {
    if (!selectedId || !messages.length) return;
    // The API returns messages oldest-first for rendering. When a conversation
    // is opened, position the viewport at the newest message instead of the
    // browser's default scrollTop (0).
    const frame = window.requestAnimationFrame(() => {
      const container = messagesContainer.current;
      if (!container) return;
      const preserved = preserveMessageScroll.current;
      if (preserved) {
        container.scrollTop =
          preserved.top + (container.scrollHeight - preserved.height);
        preserveMessageScroll.current = null;
      } else if (scrollMessagesToLatest.current) {
        container.scrollTop = container.scrollHeight;
        nearBottomRef.current = true;
        setNearBottom(true);
        setNewMessageCount(0);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, selectedId]);
  const previewAttachments = messages.flatMap(message => message.attachments.filter(isAttachmentDownloadable));
  const thumbnailUrls = useMediaUrls(previewAttachments.filter(a => ['image', 'sticker'].includes(a.type)).map(a => a.id), true);
  const mediaUrls = useMediaUrls(previewAttachments.filter(a => ['image', 'sticker', 'audio', 'voice', 'video'].includes(a.type)).map(a => a.id));
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setCrmLoading(true);
      setCrmLoadError("");
      void (async () => {
        try {
          let next = await fetchCrmContext(selectedId);
          if (next?.link && (!next.context || next.stale)) {
            try {
              next = await fetchFreshCrmContext(selectedId);
            } catch (reason) {
              if (!next.context && !cancelled)
                setCrmLoadError(
                  reason instanceof Error
                    ? reason.message
                    : "Bitrix24 bilgileri otomatik yüklenemedi.",
                );
            }
          }
          if (!cancelled) setCrmContext(next);
        } catch (reason) {
          if (!cancelled) {
            setCrmContext(null);
            setCrmLoadError(
              reason instanceof Error
                ? reason.message
                : "CRM bağlamı yüklenemedi.",
            );
          }
        } finally {
          if (!cancelled) setCrmLoading(false);
        }
      })();
      void apiJson<{ data: Note[] }>(
        `/api/v1/conversations/${selectedId}/notes`,
      )
        .then((note) => {
          if (!cancelled) setNotes(note.data);
        })
        .catch(() => {
          if (!cancelled) setNotes([]);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) {
      const timer = window.setTimeout(() => setConversationFiles([]), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    void apiJson<{ data: InboxFile[] }>(
      `/api/v1/files?conversationId=${selectedId}&limit=50`,
    )
      .then((result) => {
        if (!cancelled) setConversationFiles(result.data);
      })
      .catch(() => {
        if (!cancelled) setConversationFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);
  async function sendStoredFile(file: InboxFile) {
    if (!selectedId || !selectedChannelReadyForSend()) return;
    setUploading(true);
    setFileUploadStage("downloading");
    setOperationError("");
    try {
      await apiJson(`/api/v1/files/${file.id}/send-whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: selectedId }),
      });
      setFilePickerOpen(false);
      setFileUploadStage("ready");
      await loadMessages(selectedId);
    } catch (cause) {
      setOperationError(
        cause instanceof Error ? cause.message : "Dosya gönderilemedi.",
      );
      setFileUploadStage("failed");
    } finally {
      setUploading(false);
    }
  }
  async function refreshConversationFiles(conversationId = selectedId) {
    if (!conversationId) return;
    const result = await apiJson<{ data: InboxFile[] }>(
      `/api/v1/files?conversationId=${conversationId}&limit=50`,
    );
    setConversationFiles(result.data);
  }
  function chooseComposerFile(file: File) {
    if (!selected || file.size > 25 * 1024 * 1024) {
      setError("Dosya seçilemedi veya 25 MB sınırını aşıyor.");
      return;
    }
    setError("");
    setFileUploadStage("idle");
    setPendingComposerFile(file);
  }
  async function waitForStoredFile(fileId: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await apiJson<{ data: InboxFile }>(
        `/api/v1/files/${fileId}`,
      );
      const status = result.data.status.toUpperCase();
      if (status === "READY") {
        setFileUploadStage("ready");
        return result.data;
      }
      if (["FAILED", "DEAD_LETTER", "QUARANTINED"].includes(status)) {
        setFileUploadStage("failed");
        throw new Error("Dosya Drive'a aktarılamadı.");
      }
      setFileUploadStage(attempt === 0 ? "uploading" : "retrying");
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    setFileUploadStage("retrying");
    throw new Error(
      "Drive işlemi sürüyor. Dosyalar panelinden takip edebilirsiniz.",
    );
  }
  async function handleComposerFileMode(
    mode: "whatsapp" | "drive_and_whatsapp" | "drive_only",
  ) {
    const file = pendingComposerFile;
    const conversation = selected;
    if (!file || !conversation || !selectedChannelReadyForSend()) return;
    setUploading(true);
    setOperationError("");
    setFileUploadStage("validating");
    try {
      if (mode === "whatsapp") {
        await uploadMedia(file);
        setFileUploadStage("ready");
        setPendingComposerFile(null);
        return;
      }
      const connections = await apiJson<{
        data: Array<{ id: string; status: string }>;
      }>("/api/v1/integrations/google-drive/connections");
      const connection = connections.data.find(
        (item) => item.status === "connected",
      );
      if (!connection)
        throw new Error("Önce Google Drive bağlantısını etkinleştirin.");
      setFileUploadStage("uploading");
      const params = new URLSearchParams({
        connectionId: connection.id,
        contactId: conversation.contactId,
        conversationId: conversation.id,
        channelId: conversation.channelId,
        category: "incoming_media",
        saveOnly: "true",
      });
      const response = await apiFetch(`/api/v1/files/uploads?${params}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": file.name,
          "x-mime-type": file.type || "application/octet-stream",
        },
        body: file,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? "Dosya kaydedilemedi.");
      }
      const payload = (await response.json()) as { data: InboxFile };
      await refreshConversationFiles(conversation.id);
      if (mode === "drive_and_whatsapp") {
        const ready = await waitForStoredFile(payload.data.id);
        await sendStoredFile(ready);
      } else {
        void waitForStoredFile(payload.data.id)
          .then(() => refreshConversationFiles(conversation.id))
          .catch((cause) =>
            setOperationError(
              cause instanceof Error
                ? cause.message
                : "Drive işlemi başarısız.",
            ),
          );
      }
      setPendingComposerFile(null);
    } catch (cause) {
      setFileUploadStage("failed");
      setOperationError(
        cause instanceof Error ? cause.message : "Dosya işlemi başarısız.",
      );
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function downloadStoredFile(file: InboxFile, preview = false) {
    const result = await apiJson<{ data: { url: string } }>(
      `/api/v1/files/${file.id}/download-url`,
      { method: "POST" },
    );
    if (preview) window.open(result.data.url, "_blank", "noopener,noreferrer");
    else triggerAttachmentDownload(result.data.url);
  }
  async function updateStoredFile(
    file: InboxFile,
    body: Record<string, unknown>,
  ) {
    await apiJson(`/api/v1/files/${file.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await refreshConversationFiles();
  }
  async function archiveStoredFile(file: InboxFile) {
    if (!window.confirm(`${file.sanitized_name} arşivlensin mi?`)) return;
    await apiJson(`/api/v1/files/${file.id}/archive`, { method: "POST" });
    await refreshConversationFiles();
  }
  const selectedChannelId = selected?.channelId;
  const reactionsByTarget = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const message of messages) {
      if (message.type !== "reaction") continue;
      const target =
        typeof message.metadata.messageId === "string"
          ? message.metadata.messageId
          : typeof message.metadata.message_id === "string"
            ? message.metadata.message_id
            : null;
      if (!target) continue;
      if (message.body) (result[target] ??= []).push(message.body);
    }
    return result;
  }, [messages]);
  async function sendReaction(messageId: string, emoji: string) {
    if (!selectedId) return;
    try {
      await apiJson(`/api/v1/conversations/${selectedId}/reactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          messageId:
            messages.find((message) => message.id === messageId)
              ?.providerMessageId ?? messageId,
          emoji,
        }),
      });
      setReactionMessageId(null);
      await loadMessages(selectedId);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Reaction gönderilemedi",
      );
    }
  }
  useEffect(() => {
    if (!selectedChannelId) return;
    void Promise.all([
      apiJson<{ data: QuickReply[] }>(
        `/api/v1/quick-replies?limit=100${
          selectedId ? `&conversationId=${selectedId}` : ""
        }`,
      ),
      apiJson<{ data: Template[] }>(
        `/api/v1/templates?channelId=${selectedChannelId}&status=approved`,
      ),
    ]).then(([quick, template]) => {
      setQuickReplies(quick.data);
      setTemplates(template.data);
    });
  }, [selectedId, selectedChannelId]);
  useEffect(() => {
    if (connection === "connected") return;
    const timer = setInterval(() => {
      void loadConversations();
      void loadInboxCounts();
      if (selectedId) void loadMessages(selectedId);
    }, 3000);
    return () => clearInterval(timer);
  }, [
    connection,
    loadInboxCounts,
    loadConversations,
    loadMessages,
    selectedId,
    whatsappChannelId,
  ]);
  const realtimeHandlersRef = useRef({
    loadAiState,
    loadConversations,
    loadInboxCounts,
    loadLabels,
    loadMessages,
    selectedId,
  });
  useEffect(() => {
    realtimeHandlersRef.current = {
      loadAiState,
      loadConversations,
      loadInboxCounts,
      loadLabels,
      loadMessages,
      selectedId,
    };
  }, [
    loadAiState,
    loadConversations,
    loadInboxCounts,
    loadLabels,
    loadMessages,
    selectedId,
  ]);
  useEffect(() => {
    if (!token) return;
    let source: EventSource | undefined, reconnect: number | undefined;
    let disposed = false;
    const connect = async () => {
      // Exchange the access token over HTTPS for a one-minute, realtime-only
      // token. This avoids putting the durable access token in the URL.
      const tokenResponse = await fetch(`${API}/api/v1/realtime/token`, {
        headers: { authorization: `Bearer ${token}` },
        credentials: "include",
      });
      if (!tokenResponse.ok) {
        setConnection("offline");
        return;
      }
      const tokenBody = (await tokenResponse.json()) as {
        data?: { token?: string };
      };
      const realtimeToken = tokenBody.data?.token;
      if (disposed) return;
      if (!realtimeToken) {
        setConnection("offline");
        return;
      }
      source = new EventSource(
        `${REALTIME}?access_token=${encodeURIComponent(realtimeToken)}`,
      );
      source.onopen = () => {
        setConnection("connected");
        const handlers = realtimeHandlersRef.current;
        void handlers.loadConversations();
        void handlers.loadInboxCounts();
        if (handlers.selectedId)
          void handlers.loadMessages(handlers.selectedId);
      };
      source.onerror = () => {
        if (disposed) return;
        setConnection(navigator.onLine ? "reconnecting" : "offline");
        source?.close();
        reconnect = window.setTimeout(connect, 3000);
      };
      source.onmessage = (event) => {
        const data = JSON.parse(event.data) as RealtimeEvent;
        if (seen.current.has(data.eventId)) return;
        seen.current.add(data.eventId);
        const handlers = realtimeHandlersRef.current;
        if (
          data.conversationId === handlers.selectedId &&
          data.eventType === "message.created" &&
          !nearBottomRef.current
        )
          setNewMessageCount((current) => current + 1);
        if (data.conversationId === handlers.selectedId)
          void handlers.loadMessages(data.conversationId);
        if (
          data.eventType.startsWith("ai.") &&
          data.conversationId === handlers.selectedId
        )
          void handlers.loadAiState(data.conversationId);
        if (data.eventType.startsWith("label.")) void handlers.loadLabels();
        void handlers.loadConversations();
        void handlers.loadInboxCounts();
      };
    };
    void connect();
    return () => {
      disposed = true;
      source?.close();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [token]);
  function sendAiFeedback(
    runId: string,
    action: "rated_good" | "rated_bad" | "sent" | "edited" | "regenerated",
    finalText?: string,
  ) {
    void apiFetch("/api/v1/ai/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId,
        action,
        ...(finalText ? { finalText } : {}),
      }),
    }).catch(() => {});
  }
  async function generateAiReply(
    style?: "shorter" | "longer" | "friendlier" | "professional",
  ) {
    if (!selectedId || aiGenerating) return;
    const conversationId = selectedId;
    setAiGenerating(true);
    try {
      const response = await apiFetch(
        `/api/v1/ai/conversations/${conversationId}/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(style ? { style } : {}),
        },
      );
      const body = (await response.json()) as {
        data?: {
          runId: string;
          agentName: string;
          text: string;
          knowledgeSources?: Array<{ title: string; score: number }>;
        };
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !body.data)
        throw new Error(
          body.error?.message ?? mapAiErrorMessage(body.error?.code),
        );
      setDraft(body.data.text);
      setAiSuggestionState({
        conversationId,
        runId: body.data.runId,
        originalText: body.data.text,
        agentName: body.data.agentName,
        sources: body.data.knowledgeSources ?? [],
      });
      setOperationError("");
      requestAnimationFrame(() => composerInput.current?.focus());
    } catch (cause) {
      setOperationError(
        cause instanceof Error ? cause.message : mapAiErrorMessage(null),
      );
    } finally {
      setAiGenerating(false);
    }
  }
  async function pauseAi(minutes: number | null) {
    if (!selectedId) return;
    try {
      await apiJson(`/api/v1/ai/conversations/${selectedId}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ minutes }),
      });
      await loadAiState(selectedId);
    } catch (cause) {
      setOperationError(
        cause instanceof Error ? cause.message : "AI duraklatılamadı.",
      );
    }
  }
  async function resumeAi() {
    if (!selectedId) return;
    try {
      await apiJson(`/api/v1/ai/conversations/${selectedId}/resume`, {
        method: "POST",
      });
      await loadAiState(selectedId);
    } catch (cause) {
      setOperationError(
        cause instanceof Error ? cause.message : "AI devam ettirilemedi.",
      );
    }
  }
  async function loadAiAgentOptions() {
    if (aiAgentOptions !== null) return;
    try {
      const result = await apiJson<{
        data: Array<{
          id: string;
          name: string;
          status: string;
          published_version: number | null;
        }>;
      }>("/api/v1/ai/agents");
      setAiAgentOptions(
        (result.data ?? [])
          .filter(
            (agent) => agent.status === "active" && agent.published_version,
          )
          .map((agent) => ({ id: agent.id, name: agent.name })),
      );
    } catch {
      setAiAgentOptions([]);
    }
  }
  async function changeAiAgent(agentId: string | null) {
    if (!selectedId) return;
    try {
      await apiJson(`/api/v1/ai/conversations/${selectedId}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      await loadAiState(selectedId);
    } catch (cause) {
      setOperationError(
        cause instanceof Error ? cause.message : "Ajan değiştirilemedi.",
      );
    }
  }
  async function approveAiDraft() {
    if (!aiApproval || !selectedId) return;
    try {
      await apiJson(`/api/v1/ai/runs/${aiApproval.runId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch (cause) {
      setOperationError(
        cause instanceof Error ? cause.message : "AI taslağı gönderilemedi.",
      );
      return;
    }
    aiDismissedRuns.current.add(aiApproval.runId);
    setAiApprovalState(null);
    await loadMessages(selectedId);
  }
  async function rejectAiDraft() {
    if (!aiApproval) return;
    try {
      await apiJson(`/api/v1/ai/runs/${aiApproval.runId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch (cause) {
      setOperationError(
        cause instanceof Error ? cause.message : "AI taslağı reddedilemedi.",
      );
      return;
    }
    aiDismissedRuns.current.add(aiApproval.runId);
    setAiApprovalState(null);
  }
  function editAiDraft() {
    if (!aiApproval) return;
    setDraft(aiApproval.text);
    setAiSuggestionState({
      conversationId: aiApproval.conversationId,
      runId: aiApproval.runId,
      originalText: aiApproval.text,
      agentName: aiState?.agent_name ?? "AI",
      sources: [],
    });
    aiDismissedRuns.current.add(aiApproval.runId);
    setAiApprovalState(null);
    requestAnimationFrame(() => composerInput.current?.focus());
  }
  async function send() {
    if (!selected || !draft.trim() || !windowOpen) return;
    if (!selectedChannelReadyForSend()) return;
    const unresolved = unresolvedVariables(draft);
    if (unresolved.length > 0) {
      setOperationError(
        `Eksik hazır cevap alanları: ${unresolved.map((key) => `{{${key}}}`).join(", ")}`,
      );
      return;
    }
    const trackedQuickReply = selectedQuickReply;
    const trackedAiSuggestion = aiSuggestion;
    setAiSuggestionState(null);
    const clientMessageId = crypto.randomUUID(),
      optimistic: Message = {
        id: clientMessageId,
        conversationId: selected.id,
        providerMessageId: null,
        clientMessageId,
        body: draft.trim(),
        type: "text",
        direction: "outbound",
        status: "pending",
        sentAt: new Date().toISOString(),
        senderName: currentUserName ?? "Agent",
        metadata: {},
        attachments: [],
        errorCode: null,
        errorMessage: null,
      };
    setMessages((items) => [...items, optimistic]);
    setDraft("");
    const response = await fetch(
      `${API}/api/v1/conversations/${selected.id}/messages`,
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          clientMessageId,
          ...(whatsappChannelId !== "all"
            ? { channelId: whatsappChannelId }
            : {}),
          type: "text",
          text: optimistic.body,
          ...(replyToMessage?.providerMessageId
            ? { replyToMessageId: replyToMessage.providerMessageId }
            : {}),
        }),
      },
    );
    const body = (await response.json()) as {
      data?: Message;
      error?: { code: string; message: string };
    };
    if (response.ok && body.data)
      setMessages((items) =>
        items.map((item) =>
          item.clientMessageId === clientMessageId ? body.data! : item,
        ),
      );
    if (response.ok) {
      setReplyToMessage(null);
      setSelectedQuickReply(null);
      if (trackedAiSuggestion) {
        const edited = shouldEmitEditedFeedback(
          trackedAiSuggestion.originalText,
          optimistic.body,
        );
        sendAiFeedback(
          trackedAiSuggestion.runId,
          edited ? "edited" : "sent",
          edited ? optimistic.body : undefined,
        );
      }
      let attachmentError: string | null = null;
      if (trackedQuickReply?.attachmentId) {
        try {
          await apiJson(
            `/api/v1/quick-replies/${trackedQuickReply.id}/attachments/${trackedQuickReply.attachmentId}/send?conversationId=${selected.id}`,
            { method: "POST" },
          );
        } catch (cause) {
          attachmentError =
            cause instanceof Error
              ? cause.message
              : "Hazır cevap eki gönderilemedi.";
          setOperationError(
            `Metin gönderildi ancak ek gönderilemedi: ${attachmentError}`,
          );
        }
      }
      if (trackedQuickReply)
        await apiFetch(
          `/api/v1/quick-replies/${trackedQuickReply.id}/track-usage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              conversationId: selected.id,
              renderedContent: optimistic.body,
              eventType: attachmentError ? "failed" : "sent",
              ...(attachmentError
                ? { errorCode: "QUICK_REPLY_ATTACHMENT_SEND_FAILED" }
                : {}),
            }),
          },
        );
    } else {
      setMessages((items) =>
        items.map((item) =>
          item.clientMessageId === clientMessageId
            ? {
                ...item,
                status: "failed",
                errorCode: body.error?.code ?? "SEND_FAILED",
                errorMessage:
                  body.error?.code === "WHATSAPP_TEMPLATE_REQUIRED"
                    ? "24 saatlik pencere kapalı. Template mesajları Milestone 3’te eklenecek."
                    : (body.error?.message ?? "Gönderilemedi"),
              }
            : item,
        ),
      );
      if (trackedQuickReply)
        void apiFetch(
          `/api/v1/quick-replies/${trackedQuickReply.id}/track-usage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              conversationId: selected.id,
              renderedContent: optimistic.body,
              eventType: "failed",
              errorCode: body.error?.code ?? "SEND_FAILED",
            }),
          },
        );
    }
  }
  async function retryFailedMessage(message: Message) {
    if (
      !selected ||
      message.status !== "failed" ||
      !windowOpen ||
      !selectedChannelReadyForSend()
    )
      return;
    const clientMessageId = crypto.randomUUID();
    setMessages((items) =>
      items.map((item) =>
        item.id === message.id
          ? {
              ...item,
              clientMessageId,
              status: "pending",
              errorCode: null,
              errorMessage: null,
            }
          : item,
      ),
    );
    const response = await fetch(
      `${API}/api/v1/conversations/${selected.id}/messages`,
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          clientMessageId,
          ...(whatsappChannelId !== "all"
            ? { channelId: whatsappChannelId }
            : {}),
          type: "text",
          text: message.body,
          ...(typeof message.metadata.replyToMessageId === "string"
            ? { replyToMessageId: message.metadata.replyToMessageId }
            : {}),
        }),
      },
    );
    const body = (await response.json()) as {
      data?: Message;
      error?: { code: string; message: string };
    };
    setMessages((items) =>
      items.map((item) =>
        item.id === message.id
          ? response.ok && body.data
            ? body.data
            : {
                ...item,
                status: "failed",
                errorCode: body.error?.code ?? "SEND_FAILED",
                errorMessage: body.error?.message ?? "Gönderilemedi",
              }
          : item,
      ),
    );
  }
  async function sendInteractive() {
    if (
      !selected ||
      !windowOpen ||
      !interactiveBody.trim() ||
      !selectedChannelReadyForSend()
    )
      return;
    const options = interactiveOptions
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (!options.length) return;
    const clientMessageId = crypto.randomUUID();
    const interactive =
      interactiveMode === "list"
        ? {
            type: "list",
            body: { text: interactiveBody.trim() },
            action: {
              button: "Seçenekler",
              sections: [
                {
                  title: "Seçenekler",
                  rows: options.map((title, index) => ({
                    id: `option_${index + 1}`,
                    title,
                  })),
                },
              ],
            },
          }
        : {
            type: "button",
            body: { text: interactiveBody.trim() },
            action: {
              buttons: options.slice(0, 3).map((title, index) => ({
                type: "reply",
                reply: { id: `option_${index + 1}`, title },
              })),
            },
          };
    const response = await apiJson<{ data: Message }>(
      `/api/v1/conversations/${selected.id}/interactive`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientMessageId,
          ...(whatsappChannelId !== "all"
            ? { channelId: whatsappChannelId }
            : {}),
          text: interactiveBody.trim(),
          interactive,
        }),
      },
    );
    setMessages((items) => [...items, response.data]);
    setInteractiveBody("");
    setInteractiveOptions("");
    setInteractiveMode("none");
  }
  async function uploadMedia(file: File): Promise<boolean> {
    if (!selected || file.size > 25 * 1024 * 1024) {
      setError("Dosya seçilemedi veya 25 MB sınırını aşıyor.");
      return false;
    }
    if (!selectedChannelReadyForSend()) return false;
    setUploading(true);
    setError("");
    try {
      const response = await apiFetch(
        `/api/v1/media/uploads?conversationId=${selected.id}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-filename": file.name,
            "x-mime-type": file.type || "application/octet-stream",
          },
          body: file,
        },
      );
      if (!response.ok) throw new Error("Medya yüklenemedi.");
      await loadMessages(selected.id).catch(() => setError('Dosya gönderim kuyruğuna alındı; sohbeti yenileyin.'));
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Medya yüklenemedi");
      return false;
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function downloadAttachment(id: string) {
    const result = await apiJson<{ data: { url: string } }>(
      `/api/v1/attachments/${id}/download-url`,
      { method: "POST" },
    );
    triggerAttachmentDownload(result.data.url);
  }
  async function startVoiceRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStream.current = stream;
      const preferred = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const mediaRecorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      voiceChunks.current = [];
      setVoiceBlob(null);
      setVoiceSeconds(0);
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size) voiceChunks.current.push(event.data);
      };
      mediaRecorder.onstop = () => {
        setVoiceBlob(
          new Blob(voiceChunks.current, {
            type: mediaRecorder.mimeType || "audio/webm",
          }),
        );
        setVoiceState("preview");
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.current = mediaRecorder;
      mediaRecorder.start(250);
      setVoiceState("recording");
    } catch {
      voiceStream.current?.getTracks().forEach(track => track.stop());
      setError("Mikrofon izni verilmedi. Ses dosyası ekleyebilirsiniz.");
    }
  }
  function pauseOrResumeVoice() {
    if (!recorder.current) return;
    if (recorder.current.state === "recording") {
      recorder.current.pause();
      setVoiceState("paused");
    } else if (recorder.current.state === "paused") {
      recorder.current.resume();
      setVoiceState("recording");
    }
  }
  function stopVoiceRecording() {
    if (recorder.current?.state !== "inactive") recorder.current?.stop();
  }
  function cancelVoiceRecording() {
    if (recorder.current) recorder.current.onstop = null;
    if (recorder.current?.state !== "inactive") recorder.current?.stop();
    voiceStream.current?.getTracks().forEach((track) => track.stop());
    recorder.current = null;
    voiceChunks.current = [];
    setVoiceBlob(null);
    setVoiceState("idle");
    setVoiceSeconds(0);
  }
  async function sendVoiceRecording() {
    if (!voiceBlob) return;
    const extension = voiceBlob.type.includes("ogg") ? "ogg" : voiceBlob.type.includes('mp4') ? 'm4a' : "webm";
    const uploaded = await uploadMedia(
      new File([voiceBlob], `voice-${crypto.randomUUID()}.${extension}`, {
        type: voiceBlob.type || "audio/webm",
      }),
    );
    if (!uploaded) return;
    setVoiceBlob(null);
    setVoiceState("idle");
    setVoiceSeconds(0);
  }
  async function operate(input: Record<string, unknown>) {
    if (!selected) return;
    await operateConversation(selected.id, input);
  }
  async function startConversation(input: {
    channelId: string;
    phone: string;
    displayName?: string;
  }) {
    const response = await apiJson<{
      data: { conversation: Conversation; created: boolean };
    }>("/api/v1/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const conversation = response.data.conversation;
    resetConversationUi();
    setQuery("");
    setFilterScope("all");
    setConversationFilters({ ...DEFAULT_CONVERSATION_FILTERS });
    setWhatsappChannelId(conversation.channelId);
    setConversations((current) => [
      conversation,
      ...current.filter((item) => item.id !== conversation.id),
    ]);
    setSelectedId(conversation.id);
    setMobileChatOpen(true);
    setNewConversationOpen(false);
    void loadInboxCounts();
  }
  async function operateConversation(
    conversationId: string,
    input: Record<string, unknown>,
  ) {
    setOperationError("");
    try {
      const result = await apiJson<{
        data: { id?: string; canonicalConversationId?: string | null };
      }>(`/api/v1/conversations/${conversationId}/operations`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const canonicalConversationId =
        result.data.canonicalConversationId ?? result.data.id;
      if (
        input.status === "open" &&
        canonicalConversationId &&
        canonicalConversationId !== conversationId
      ) {
        setFilterScope("all");
        setSelectedId(canonicalConversationId);
      }
      await Promise.all([loadConversations(), loadInboxCounts()]);
    } catch (reason) {
      setOperationError(
        reason instanceof Error
          ? reason.message
          : "Sohbet işlemi tamamlanamadı.",
      );
    } finally {
      setConversationMenu(null);
    }
  }
  async function assignConversation(userId: string) {
    if (!selected || !canAssignConversations || assignmentLoading) return;
    setAssignmentLoading(true);
    setError("");
    try {
      if (userId) {
        await apiJson(`/api/v1/conversations/${selected.id}/assign`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId,
            reason: "manual",
            origin: "manual",
          }),
        });
      } else {
        const response = await apiFetch(
          `/api/v1/conversations/${selected.id}/assign`,
          { method: "DELETE" },
        );
        if (!response.ok) throw new Error("Atama kaldırılamadı.");
      }
      await Promise.all([loadConversations(), loadInboxCounts()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Atama yapılamadı.");
    } finally {
      setAssignmentLoading(false);
    }
  }
  async function markConversationReadState(id: string, unread: boolean) {
    setError("");
    try {
      await apiJson(
        `/api/v1/conversations/${id}/${unread ? "unread" : "read"}`,
        { method: "POST" },
      );
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === id
            ? {
                ...conversation,
                unreadCount: unread ? Math.max(1, conversation.unreadCount) : 0,
              }
            : conversation,
        ),
      );
      await loadInboxCounts();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Okunma durumu güncellenemedi.",
      );
    } finally {
      setConversationMenu(null);
    }
  }
  async function toggleConversationLabel(labelId: string) {
    if (!selected) return;
    const assigned = selectedLabelIds.includes(labelId);
    const conversationId = selected.id;
    const mutation = (labelMutationRef.current ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const path = `/api/v1/conversations/${conversationId}/labels/${labelId}`;
        if (assigned) {
          const response = await apiFetch(path, { method: "DELETE" });
          if (!response.ok) throw new Error("Etiket kaldırılamadı.");
        } else {
          await apiJson(path, { method: "POST" });
        }
        setSelectedLabelIds((current) =>
          assigned
            ? current.filter((id) => id !== labelId)
            : [...new Set([...current, labelId])],
        );
        await Promise.all([loadConversations(), loadLabels()]);
      });
    labelMutationRef.current = mutation;
    try {
      await mutation;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Etiket güncellenemedi.",
      );
    } finally {
      if (labelMutationRef.current === mutation)
        labelMutationRef.current = null;
    }
  }
  async function createConversationLabel() {
    const name = newLabelName.trim();
    if (!name) return;
    setLabelActionError("");
    try {
      const result = await apiJson<{ data: ConversationLabel }>(
        "/api/v1/labels",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, color: newLabelColor }),
        },
      );
      setLabels((current) =>
        [...current, result.data].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setNewLabelName("");
      setNewLabelOpen(false);
      setLabelsOpen(true);
    } catch (reason) {
      setLabelActionError(
        reason instanceof Error ? reason.message : "Etiket oluşturulamadı.",
      );
    }
  }
  async function refreshCrm() {
    if (!selected) return;
    setCrmLoading(true);
    setCrmLoadError("");
    try {
      setCrmContext(await fetchFreshCrmContext(selected.id));
    } catch (reason) {
      setCrmLoadError(
        reason instanceof Error
          ? reason.message
          : "Bitrix24 bilgileri yenilenemedi.",
      );
    } finally {
      setCrmLoading(false);
    }
  }
  async function addNote() {
    if (!selected || !noteDraft.trim()) return;
    await apiJson(`/api/v1/conversations/${selected.id}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: noteDraft, mentionUserIds: [] }),
    });
    setNoteDraft("");
    const result = await apiJson<{ data: Note[] }>(
      `/api/v1/conversations/${selected.id}/notes`,
    );
    setNotes(result.data);
  }
  async function chooseQuick(reply: QuickReply) {
    if (!selected) return;
    try {
      type RenderResult = {
        data: {
          content: string;
          missingVariables: string[];
          unknownVariables: string[];
          variableDefinitions: Array<{
            variable_key: string;
            label: string;
            required: boolean;
            missing_policy: "block" | "manual" | "default" | "remove";
          }>;
          attachments: Array<{
            id: string;
            filename: string;
            mime_type: string;
            size_bytes: number;
            attachment_type: string;
          }>;
        };
      };
      let rendered = await apiJson<RenderResult>(
        `/api/v1/quick-replies/${reply.id}/render`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId: selected.id }),
        },
      );
      const manualValues: Record<string, string> = {};
      for (const key of rendered.data.missingVariables) {
        const definition = rendered.data.variableDefinitions.find(
          (item) =>
            item.variable_key === key && item.missing_policy === "manual",
        );
        if (!definition) continue;
        const value = window.prompt(`${definition.label} için değer girin`, "");
        if (value?.trim()) manualValues[key] = value.trim();
      }
      if (Object.keys(manualValues).length > 0)
        rendered = await apiJson<RenderResult>(
          `/api/v1/quick-replies/${reply.id}/render`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              conversationId: selected.id,
              manualValues,
            }),
          },
        );
      const unresolved = [
        ...new Set([
          ...rendered.data.missingVariables,
          ...rendered.data.unknownVariables,
          ...unresolvedVariables(rendered.data.content),
        ]),
      ];
      if (unresolved.length > 0) {
        setOperationError(
          `Hazır cevap eklenemedi. Eksik alanlar: ${unresolved
            .map((key) => `{{${key}}}`)
            .join(", ")}`,
        );
        void apiFetch(`/api/v1/quick-replies/${reply.id}/track-usage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: selected.id,
            renderedContent: rendered.data.content,
            eventType: "variable_error",
            errorCode: "QUICK_REPLY_VARIABLES_UNRESOLVED",
          }),
        });
        return;
      }
      const input = composerInput.current;
      const inserted = insertQuickReplyAtCursor(
        draft,
        rendered.data.content,
        input?.selectionStart ?? draft.length,
        input?.selectionEnd ?? draft.length,
      );
      setDraft(inserted.value);
      setSelectedQuickReply({
        id: reply.id,
        renderedContent: rendered.data.content,
        attachmentId: rendered.data.attachments[0]?.id ?? null,
      });
      setQuickMenuForced(false);
      setQuickMenuIndex(0);
      setComposerCursor(inserted.cursor);
      setOperationError("");
      void apiFetch(`/api/v1/quick-replies/${reply.id}/track-usage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: selected.id,
          renderedContent: rendered.data.content,
          eventType: "selected",
        }),
      });
      requestAnimationFrame(() => {
        composerInput.current?.focus();
        composerInput.current?.setSelectionRange(
          inserted.cursor,
          inserted.cursor,
        );
      });
    } catch (cause) {
      setOperationError(
        cause instanceof Error ? cause.message : "Hazır cevap eklenemedi.",
      );
    }
  }
  async function sendTemplate() {
    if (!selected || !selectedTemplate || !selectedChannelReadyForSend())
      return;
    const response = await apiJson<{ data: Message }>(
      `/api/v1/conversations/${selected.id}/template-messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          ...(whatsappChannelId !== "all"
            ? { channelId: whatsappChannelId }
            : {}),
          templateId: selectedTemplate.id,
          language: selectedTemplate.language,
          variables: templateVariables,
        }),
      },
    );
    setMessages((items) => [...items, response.data]);
    setShowTemplate(false);
    setSelectedTemplate(null);
    setTemplateVariables({});
  }
  async function chooseTemplate(template: Template) {
    const detail = await apiJson<{
      data: Template & {
        variables: Array<{
          component: string;
          position: number;
          example_value: string | null;
        }>;
      };
    }>(`/api/v1/templates/${template.id}`);
    setSelectedTemplate(detail.data);
    setTemplateVariables(
      Object.fromEntries(
        detail.data.variables.map((variable) => [
          `${variable.component}.${variable.position}`,
          variable.example_value ?? "",
        ]),
      ),
    );
  }
  return (
    <div className="app-shell app-shell-premium inbox-shell-premium">
      <a className="skip-link" href="#inbox-main">
        Ana içeriğe geç
      </a>
      <AppSidebar showWorkspace={false} />
      <main id="inbox-main" className="main-area" tabIndex={-1}>
        <header className="topbar premium-topbar inbox-topbar">
          <MobileNavigation />
          <WorkspaceSwitcher />
          <label className="global-search">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Kişi, telefon veya mesaj ara…"
            />
          </label>
          <select
            className="channel-account-select"
            value={whatsappChannelId}
            onChange={(event) => {
              const channelId = event.target.value;
              if (channelId === whatsappChannelId) return;
              conversationRequestRef.current.controller?.abort();
              conversationRequestRef.current.id += 1;
              channelSwitchTargetRef.current = channelId;
              setChannelSwitching(true);
              setWhatsappChannelId(channelId);
            }}
            aria-label="WhatsApp hesabı"
            aria-busy={channelSwitching}
          >
            <option value="all">Tüm WhatsApp Hesapları</option>
            {whatsappAccounts.flatMap((account) =>
              account.channels.map((channel) => (
                <option key={channel.channelId} value={channel.channelId}>
                  {channel.channelName} · {channel.maskedPhoneNumber}
                </option>
              )),
            )}
          </select>
          <div className="topbar-actions">
            <span className={`channel-health ${connection}`}>
              {connection === "offline" ? (
                <WifiOff size={13} />
              ) : (
                <Wifi size={13} />
              )}{" "}
              {connection === "connected"
                ? "Connected"
                : connection === "offline"
                  ? "Offline"
                  : "Reconnecting"}
            </span>
            <ThemeToggle />
            <NotificationCenter />
            <button
              ref={newConversationTriggerRef}
              type="button"
              className="primary-button compact-button"
              disabled={!canStartConversation}
              title={
                canStartConversation
                  ? "Yeni konuşma"
                  : "Kullanılabilir bir WhatsApp hesabı bulunamadı"
              }
              onClick={() => setNewConversationOpen(true)}
            >
              <Plus size={16} />
              Yeni konuşma
            </button>
          </div>
        </header>
        <section
          className={`inbox-grid${selected && mobileChatOpen ? " show-chat" : ""}`}
          aria-busy={channelSwitching}
        >
          <aside className="filter-column">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Çalışma alanı</p>
                <h1>Gelen Kutusu</h1>
              </div>
              <span className="inbox-live-indicator">
                <i aria-hidden="true" />
                Canlı
              </span>
            </div>
            {[
              { label: "Tüm konuşmalar", scope: "all", count: inboxCounts.all },
              {
                label: "Bana atanmış",
                scope: "assigned_to_me",
                count: inboxCounts.assignedToMe,
              },
              {
                label: "Atanmamış",
                scope: "unassigned",
                count: inboxCounts.unassigned,
              },
              {
                label: "Okunmamış",
                scope: "unread",
                count: inboxCounts.unread,
              },
            ].map((item) => (
              <button
                className={
                  filterScope === item.scope
                    ? "filter-item selected"
                    : "filter-item"
                }
                key={item.scope}
                onClick={() => selectSidebarFilter(item.scope)}
              >
                <span>{item.label}</span>
                <b>{item.count}</b>
              </button>
            ))}
            <button
              className={
                filterScope === "archived"
                  ? "filter-item selected"
                  : "filter-item"
              }
              onClick={() => selectSidebarFilter("archived")}
            >
              <span>Arşiv</span>
              <b>{inboxCounts.archived}</b>
            </button>
            <div className="label-filter-section">
              <div className="label-filter-heading">
                <button
                  type="button"
                  className="filter-section-title label-filter-toggle"
                  aria-expanded={labelsOpen}
                  onClick={() => setLabelsOpen((open) => !open)}
                >
                  <span>Etiketler</span>
                  <ChevronDown
                    size={15}
                    className={
                      labelsOpen ? "label-chevron open" : "label-chevron"
                    }
                  />
                </button>
                {canManageLabelSettings && (
                  <button
                    type="button"
                    className="label-add-button"
                    aria-label="Etiket ekle"
                    onClick={() => {
                      setLabelActionError("");
                      setNewLabelOpen((open) => !open);
                      setLabelsOpen(true);
                    }}
                  >
                    <Plus size={15} />
                  </button>
                )}
              </div>
              {newLabelOpen && (
                <div className="label-create-form">
                  <input
                    aria-label="Yeni etiket adı"
                    placeholder="Etiket adı"
                    maxLength={40}
                    value={newLabelName}
                    onChange={(event) => setNewLabelName(event.target.value)}
                  />
                  <input
                    aria-label="Yeni etiket rengi"
                    type="color"
                    value={newLabelColor}
                    onChange={(event) => setNewLabelColor(event.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => void createConversationLabel()}
                  >
                    Ekle
                  </button>
                </div>
              )}
              {labelActionError && (
                <p className="label-inline-error">{labelActionError}</p>
              )}
              {labelsOpen && labelLoadError && (
                <div className="label-inline-state error">
                  <span>{labelLoadError}</span>
                  <button type="button" onClick={() => void loadLabels()}>
                    Tekrar dene
                  </button>
                </div>
              )}
              {labelsOpen && !labelLoadError && labels.length === 0 && (
                <p className="label-inline-state">
                  Henüz etiket oluşturulmadı.
                </p>
              )}
              {labelsOpen &&
                !labelLoadError &&
                labels.map((label) => (
                  <button
                    className={
                      filterScope === `label:${label.id}`
                        ? "filter-item selected"
                        : "filter-item"
                    }
                    key={label.id}
                    onClick={() => selectSidebarFilter(`label:${label.id}`)}
                  >
                    <span>
                      <i
                        className="label-dot"
                        style={{ background: label.color }}
                      />
                      {label.name}
                    </span>
                    <b>{label.usage_count ?? ""}</b>
                  </button>
                ))}
            </div>
          </aside>
          <section className="conversation-column">
            <div className="list-toolbar">
              <label>
                <Search size={16} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Konuşmalarda ara"
                />
              </label>
              <div className="conversation-filter-control" ref={filterMenuRef}>
                <button
                  type="button"
                  className={
                    activeFilterCount > 0
                      ? "icon-button filter-trigger active"
                      : "icon-button filter-trigger"
                  }
                  aria-label={
                    activeFilterCount > 0
                      ? `Konuşma filtreleri, ${activeFilterCount} etkin`
                      : "Konuşmaları filtrele"
                  }
                  aria-haspopup="dialog"
                  aria-expanded={filterMenuOpen}
                  aria-controls="conversation-filter-menu"
                  onClick={toggleConversationFilters}
                >
                  <Filter size={16} />
                  {activeFilterCount > 0 && (
                    <span className="filter-count" aria-hidden="true">
                      {activeFilterCount}
                    </span>
                  )}
                </button>
                {filterMenuOpen && (
                  <div
                    id="conversation-filter-menu"
                    className="conversation-filter-menu"
                    role="dialog"
                    aria-label="Konuşma filtreleri"
                  >
                    <div className="conversation-filter-header">
                      <div>
                        <strong>Konuşmaları filtrele</strong>
                        <span>İhtiyacın olan sohbetlere odaklan</span>
                      </div>
                      <button
                        type="button"
                        aria-label="Filtreleri kapat"
                        onClick={() => setFilterMenuOpen(false)}
                      >
                        <X size={16} />
                      </button>
                    </div>

                    <label className="conversation-filter-check">
                      <input
                        type="checkbox"
                        checked={draftConversationFilters.unreadOnly}
                        onChange={(event) =>
                          setDraftConversationFilters((current) => ({
                            ...current,
                            unreadOnly: event.target.checked,
                          }))
                        }
                      />
                      <span>
                        <strong>Okunmamış</strong>
                        <small>Yanıt bekleyen yeni mesajlar</small>
                      </span>
                    </label>

                    <fieldset>
                      <legend>Atama</legend>
                      <div className="conversation-filter-options">
                        {[
                          ["all", "Tümü"],
                          ["assigned_to_me", "Bana atanmış"],
                          ["unassigned", "Atanmamış"],
                        ].map(([value, label]) => (
                          <label key={value}>
                            <input
                              type="radio"
                              name="conversation-assignment-filter"
                              value={value}
                              checked={
                                draftConversationFilters.assignment === value
                              }
                              onChange={() =>
                                setDraftConversationFilters((current) => ({
                                  ...current,
                                  assignment:
                                    value as ConversationToolbarFilters["assignment"],
                                }))
                              }
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset>
                      <legend>Durum</legend>
                      <div className="conversation-filter-options">
                        {[
                          ["all", "Tümü"],
                          ["open", "Açık"],
                          ["waiting", "Beklemede"],
                          ["snoozed", "Ertelenmiş"],
                          ["closed", "Kapatılmış"],
                          ["archived", "Arşiv"],
                        ].map(([value, label]) => (
                          <label key={value}>
                            <input
                              type="radio"
                              name="conversation-status-filter"
                              value={value}
                              checked={
                                draftConversationFilters.status === value
                              }
                              onChange={() =>
                                setDraftConversationFilters((current) => ({
                                  ...current,
                                  status:
                                    value as ConversationToolbarFilters["status"],
                                }))
                              }
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <div className="conversation-filter-selects">
                      <label>
                        <span>WhatsApp hesabı</span>
                        <select
                          value={draftChannelId}
                          onChange={(event) =>
                            setDraftChannelId(event.target.value)
                          }
                        >
                          <option value="all">Tüm hesaplar</option>
                          {whatsappAccounts.flatMap((account) =>
                            account.channels.map((channel) => (
                              <option
                                key={channel.channelId}
                                value={channel.channelId}
                              >
                                {channel.channelName} ·{" "}
                                {channel.maskedPhoneNumber}
                              </option>
                            )),
                          )}
                        </select>
                      </label>
                      <label>
                        <span>Etiket eşleşmesi</span>
                        <select
                          value={draftConversationFilters.labelOperator}
                          onChange={(event) =>
                            setDraftConversationFilters((current) => ({
                              ...current,
                              labelOperator: event.target.value as
                                "any" | "all" | "not",
                            }))
                          }
                        >
                          <option value="any">Herhangi biri (ANY)</option>
                          <option value="all">Tümü (ALL)</option>
                          <option value="not">Hariç tut (NOT)</option>
                        </select>
                      </label>
                      <label>
                        <span>Etiketler</span>
                        <select
                          multiple
                          value={draftConversationFilters.labelIds}
                          onChange={(event) =>
                            setDraftConversationFilters((current) => ({
                              ...current,
                              labelIds: Array.from(
                                event.currentTarget.selectedOptions,
                                (option) => option.value,
                              ),
                              unlabeled: false,
                            }))
                          }
                        >
                          {labels.map((label) => (
                            <option key={label.id} value={label.id}>
                              {label.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="filter-checkbox">
                        <input
                          type="checkbox"
                          checked={draftConversationFilters.unlabeled}
                          onChange={(event) =>
                            setDraftConversationFilters((current) => ({
                              ...current,
                              unlabeled: event.target.checked,
                              labelIds: event.target.checked
                                ? []
                                : current.labelIds,
                            }))
                          }
                        />
                        <span>Etiketsiz konuşmalar</span>
                      </label>
                    </div>

                    <div className="conversation-filter-actions">
                      <button
                        type="button"
                        className="filter-clear-button"
                        onClick={clearConversationFilters}
                      >
                        Filtreleri temizle
                      </button>
                      <button
                        type="button"
                        className="filter-apply-button"
                        onClick={applyConversationFilters}
                      >
                        Uygula
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={
                  conversationDensity === "comfortable"
                    ? "Kompakt görünümü aç"
                    : "Rahat görünümü aç"
                }
                aria-pressed={conversationDensity === "compact"}
                onClick={() =>
                  setConversationDensity((current) =>
                    current === "comfortable" ? "compact" : "comfortable",
                  )
                }
              >
                <Rows3 size={16} />
              </button>
            </div>
            <div className="conversation-list-summary" aria-live="polite">
              <span>
                <strong>{activeInboxLabel}</strong>
                <small>{conversations.length} konuşma gösteriliyor</small>
              </span>
              <span className="inbox-unread-summary">
                {inboxCounts.unread} okunmamış
              </span>
            </div>
            {operationError && (
              <div
                className="conversation-operation-error"
                role="alert"
                aria-live="assertive"
              >
                <span>{operationError}</span>
                <button
                  type="button"
                  aria-label="İşlem hatasını kapat"
                  onClick={() => setOperationError("")}
                >
                  Kapat
                </button>
              </div>
            )}
            {!hasChannelAccess ? (
              <div
                className="inbox-state channel-access-warning"
                role="status"
                aria-live="polite"
              >
                <strong>WhatsApp kanal yetkisi gerekli</strong>
                <span>
                  Bu çalışma alanında size atanmış bir WhatsApp kanalı yok.
                  Yöneticinizden kanal erişimi istemelisiniz.
                </span>
              </div>
            ) : loading ? (
              <div className="inbox-state" role="status" aria-live="polite">
                Konuşmalar yükleniyor…
              </div>
            ) : error ? (
              <div
                className="inbox-state error"
                role="alert"
                aria-live="assertive"
              >
                <strong>Bağlantı kurulamadı</strong>
                <span>{error}</span>
                <button onClick={() => void loadConversations()}>
                  Tekrar dene
                </button>
              </div>
            ) : conversations.length === 0 ? (
              <div className="inbox-state">Henüz konuşma yok.</div>
            ) : (
              <div
                className={`conversation-list density-${conversationDensity}`}
              >
                {conversations.map((item) => (
                  <button
                    data-conversation-id={item.id}
                    onClick={() => selectConversation(item)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setConversationMenu({
                        id: item.id,
                        x: Math.min(event.clientX, window.innerWidth - 250),
                        y: Math.min(event.clientY, window.innerHeight - 300),
                      });
                    }}
                    className={
                      selectedId === item.id
                        ? "conversation-row selected"
                        : "conversation-row"
                    }
                    key={item.id}
                  >
                    <ContactAvatar
                      contactName={item.contactName}
                      initials={item.avatar}
                      profilePictureUrl={item.profilePictureUrl}
                    />
                    <span className="conversation-copy">
                      <span className="row-title">
                        <strong>{item.contactName}</strong>
                        <time>
                          {formatConversationTime(item.lastMessageAt)}
                        </time>
                      </span>
                      <span
                        className={
                          drafts[item.id] ? "preview draft-preview" : "preview"
                        }
                      >
                        {drafts[item.id] ? (
                          <strong>Taslak:</strong>
                        ) : item.direction === "outbound" ? (
                          item.lastProviderStatus === "read" ? (
                            <CheckCheck
                              className="message-status read"
                              size={13}
                            />
                          ) : item.lastProviderStatus === "delivered" ? (
                            <CheckCheck
                              className="message-status delivered"
                              size={13}
                            />
                          ) : item.lastProviderStatus === "failed" ? (
                            <WifiOff
                              className="message-status failed"
                              size={12}
                            />
                          ) : item.lastProviderStatus === "pending" ? (
                            <Clock3
                              className="message-status pending"
                              size={12}
                            />
                          ) : (
                            <Check className="message-status sent" size={12} />
                          )
                        ) : null}{" "}
                        {drafts[item.id] || item.preview || "Yeni konuşma"}
                      </span>
                      <span className="row-tags">
                        {(item.labels ?? []).slice(0, 3).map((label) => (
                          <em
                            key={label.id}
                            style={{
                              background: label.color,
                              color: labelTextColor(label.color),
                            }}
                          >
                            {label.icon ? `${label.icon} ` : ""}
                            {label.name}
                          </em>
                        ))}
                        {(item.labels?.length ?? 0) > 3 && (
                          <em
                            title={item.labels
                              .slice(3)
                              .map((label) => label.name)
                              .join(", ")}
                          >
                            +{item.labels.length - 3}
                          </em>
                        )}
                        {(item.labels?.length ?? 0) === 0 &&
                          conversationCardLabels(item.tags, item.stage).map(
                            (label) => <em key={label}>{label}</em>,
                          )}
                        <small>{item.channelName}</small>
                      </span>
                    </span>
                    {item.unreadCount > 0 && (
                      <b className="unread-count">{item.unreadCount}</b>
                    )}
                  </button>
                ))}
                {conversationCursor && (
                  <button
                    className="load-more-button"
                    onClick={() => void loadConversations(true)}
                  >
                    Daha fazla yükle
                  </button>
                )}
              </div>
            )}
            {conversationMenu &&
              (() => {
                const item = conversations.find(
                  (conversation) => conversation.id === conversationMenu.id,
                );
                if (!item) return null;
                return (
                  <div
                    className="conversation-context-menu"
                    style={{
                      left: conversationMenu.x,
                      top: conversationMenu.y,
                    }}
                    role="menu"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (
                        !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                          event.key,
                        )
                      )
                        return;
                      event.preventDefault();
                      const items = Array.from(
                        event.currentTarget.querySelectorAll<HTMLButtonElement>(
                          '[role="menuitem"]',
                        ),
                      );
                      const current = items.indexOf(
                        document.activeElement as HTMLButtonElement,
                      );
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? items.length - 1
                            : event.key === "ArrowDown"
                              ? (current + 1) % items.length
                              : (current - 1 + items.length) % items.length;
                      items[next]?.focus();
                    }}
                  >
                    <button
                      autoFocus
                      role="menuitem"
                      onClick={() =>
                        void markConversationReadState(
                          item.id,
                          item.unreadCount === 0,
                        )
                      }
                    >
                      {item.unreadCount > 0
                        ? "Okundu olarak işaretle"
                        : "Okunmadı olarak işaretle"}
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        void operateConversation(item.id, { pinned: true });
                        setConversationMenu(null);
                      }}
                    >
                      Sohbeti sabitle
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        void operateConversation(item.id, {
                          mutedUntil: new Date(
                            Date.now() + 8 * 60 * 60 * 1000,
                          ).toISOString(),
                        });
                        setConversationMenu(null);
                      }}
                    >
                      8 saat sessize al
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        void operateConversation(item.id, {
                          status:
                            item.status === "archived" ? "open" : "archived",
                        });
                        setConversationMenu(null);
                      }}
                    >
                      {item.status === "archived"
                        ? "Arşivden çıkar"
                        : "Arşivle"}
                    </button>
                  </div>
                );
              })()}
          </section>
          <section className="chat-column">
            {selected ? (
              <>
                <header className="chat-header">
                  <button
                    type="button"
                    className="icon-button back-button"
                    aria-label="Konuşma listesine dön"
                    onClick={() => setMobileChatOpen(false)}
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <button
                    type="button"
                    className="chat-person-button"
                    onClick={() => setContactDetailsOpen(true)}
                    aria-label={`${selected.contactName} kişi bilgilerini aç`}
                  >
                    <ContactAvatar
                      contactName={selected.contactName}
                      initials={selected.avatar}
                      profilePictureUrl={selected.profilePictureUrl}
                    />
                    <span className="chat-person">
                      <strong>{selected.contactName}</strong>
                      <span className="chat-person-meta">
                        <span>
                          {selected.isGroup ? "WhatsApp grubu" : selected.phone}
                        </span>
                        <span className="chat-channel-badge">
                          <i aria-hidden="true" />
                          {selected.channelName}
                        </span>
                      </span>
                    </span>
                  </button>
                  <div className="chat-actions">
                    {aiChipKind && aiState && (
                      <details
                        className="chat-more-actions"
                        onToggle={(event) => {
                          if (
                            (event.target as HTMLDetailsElement).open &&
                            ["owner", "admin"].includes(currentUserRole ?? "")
                          )
                            void loadAiAgentOptions();
                        }}
                      >
                        <summary
                          className={`status-pill ${
                            aiChipKind === "active"
                              ? "healthy"
                              : aiChipKind === "paused"
                                ? "warning"
                                : "pending"
                          }`}
                          aria-label={`AI durumu: ${aiState.agent_name} · ${AI_STATE_LABELS[aiChipKind]}`}
                        >
                          <Bot size={13} aria-hidden="true" />
                          <span>
                            &nbsp;{aiState.agent_name} ·{" "}
                            {AI_STATE_LABELS[aiChipKind]}
                          </span>
                        </summary>
                        <div role="menu">
                          {aiChipKind === "active" ? (
                            <>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => void pauseAi(15)}
                              >
                                AI&apos;yı duraklat · 15 dk
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => void pauseAi(60)}
                              >
                                AI&apos;yı duraklat · 1 saat
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => void pauseAi(1440)}
                              >
                                AI&apos;yı duraklat · 24 saat
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => void pauseAi(null)}
                              >
                                AI&apos;yı duraklat · Süresiz
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => void resumeAi()}
                            >
                              AI&apos;yı devam ettir
                            </button>
                          )}
                          {["owner", "admin"].includes(
                            currentUserRole ?? "",
                          ) && (
                            <label className="chat-more-agent-select">
                              <span className="sr-only">
                                Bu konuşmanın AI ajanı
                              </span>
                              <select
                                value={aiState.agent_id ?? ""}
                                aria-label="Bu konuşmanın AI ajanı"
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) =>
                                  void changeAiAgent(
                                    event.target.value || null,
                                  )
                                }
                              >
                                <option value="">Kanal varsayılanı</option>
                                {(aiAgentOptions ?? []).map((agent) => (
                                  <option key={agent.id} value={agent.id}>
                                    {agent.name}
                                  </option>
                                ))}
                                {aiAgentOptions !== null &&
                                  aiState.agent_id &&
                                  !aiAgentOptions.some(
                                    (agent) => agent.id === aiState.agent_id,
                                  ) && (
                                    <option value={aiState.agent_id}>
                                      {aiState.agent_name}
                                    </option>
                                  )}
                              </select>
                            </label>
                          )}
                        </div>
                      </details>
                    )}
                    <button
                      className="icon-button"
                      aria-label="Konuşmada ara"
                      aria-pressed={conversationSearchOpen}
                      onClick={() =>
                        setConversationSearchOpen((current) => !current)
                      }
                    >
                      <Search size={17} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Kişi bilgileri"
                      onClick={() => setContactDetailsOpen(true)}
                    >
                      <Info size={17} />
                    </button>
                    <details className="chat-more-actions">
                      <summary
                        className="icon-button"
                        aria-label="Diğer konuşma işlemleri"
                      >
                        <MoreHorizontal size={18} />
                      </summary>
                      <div role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => void operate({ pinned: true })}
                        >
                          <Pin size={17} />
                          Sabitle
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            void operate({
                              mutedUntil: new Date(
                                Date.now() + 24 * 60 * 60 * 1000,
                              ).toISOString(),
                            })
                          }
                        >
                          <BellOff size={17} />
                          Sessize al
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            void operate({
                              status:
                                selected.status === "archived"
                                  ? "open"
                                  : "archived",
                            })
                          }
                        >
                          {selected.status === "archived" ? (
                            <RotateCcw size={17} />
                          ) : (
                            <Archive size={17} />
                          )}
                          {selected.status === "archived"
                            ? "Arşivden çıkar"
                            : "Arşivle"}
                        </button>
                      </div>
                    </details>
                  </div>
                </header>
                {conversationSearchOpen && (
                  <div className="conversation-search">
                    <label>
                      <Search size={16} />
                      <input
                        autoFocus
                        value={messageSearchQuery}
                        onChange={(event) => {
                          const value = event.target.value;
                          setMessageSearchQuery(value);
                          if (value.trim().length < 2) {
                            setMessageSearchResults([]);
                            setMessageSearchLoading(false);
                          }
                        }}
                        placeholder="Bu konuşmada ara…"
                        aria-label="Bu konuşmada ara"
                      />
                    </label>
                    <span>
                      {messageSearchLoading
                        ? "Aranıyor…"
                        : messageSearchQuery.trim().length < 2
                          ? "En az 2 karakter"
                          : `${messageSearchResults.length} sonuç`}
                    </span>
                    <button
                      type="button"
                      aria-label="Konuşma aramasını kapat"
                      onClick={() => setConversationSearchOpen(false)}
                    >
                      <X size={17} />
                    </button>
                    {messageSearchResults.length > 0 && (
                      <div className="conversation-search-results">
                        {messageSearchResults.map((result) => (
                          <button
                            type="button"
                            key={result.id}
                            onClick={() => void jumpToSearchResult(result)}
                          >
                            <span>
                              {result.highlights.map((part, index) =>
                                part.match ? (
                                  <mark key={index}>{part.text}</mark>
                                ) : (
                                  <Fragment key={index}>{part.text}</Fragment>
                                ),
                              )}
                            </span>
                            <time>
                              {formatConversationTime(result.occurredAt)}
                            </time>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="conversation-context">
                  <span>
                    <Clock3 size={13} />
                    {windowOpen
                      ? "24 saatlik pencere açık"
                      : "Template gerekli"}
                  </span>
                  {canAssignConversations && (
                    <select
                      className="conversation-assignee-select"
                      aria-label="Sohbet sorumlusu"
                      value={selected.assigneeId ?? ""}
                      disabled={assignmentLoading}
                      onChange={(event) =>
                        void assignConversation(event.target.value)
                      }
                    >
                      <option value="">Atanmamış</option>
                      {assignees.map((assignee) => (
                        <option value={assignee.id} key={assignee.id}>
                          {assignee.fullName}
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    aria-label="Konuşma durumu"
                    value={selected.status}
                    onChange={(event) =>
                      void operate({ status: event.target.value })
                    }
                  >
                    <option value="open">Açık</option>
                    <option value="waiting">Bekliyor</option>
                    <option value="closed">Kapalı</option>
                    <option value="archived">Arşiv</option>
                    <option value="spam">Spam</option>
                  </select>
                  <div className="conversation-label-picker">
                    {selectedLabelIds.map((labelId) => {
                      const label = labels.find((item) => item.id === labelId);
                      if (!label) return null;
                      return (
                        <button
                          type="button"
                          className="conversation-label-chip"
                          key={label.id}
                          onClick={() => void toggleConversationLabel(label.id)}
                          title="Etiketi kaldır"
                          style={{
                            background: label.color,
                            color: labelTextColor(label.color),
                          }}
                        >
                          {label.icon ? <span>{label.icon}</span> : null}
                          {label.name}
                        </button>
                      );
                    })}
                    <select
                      aria-label="Sohbet etiketi ekle"
                      value=""
                      onChange={(event) => {
                        if (event.target.value)
                          void toggleConversationLabel(event.target.value);
                      }}
                    >
                      <option value="">Etiket ekle</option>
                      {labels
                        .filter((label) => !selectedLabelIds.includes(label.id))
                        .map((label) => (
                          <option key={label.id} value={label.id}>
                            {label.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
                <div
                  className="messages"
                  ref={messagesContainer}
                  onScroll={handleMessagesScroll}
                >
                  {messageCursor && (
                    <button
                      type="button"
                      className="load-more-button"
                      onClick={() => void loadMessages(selected.id, true)}
                    >
                      Daha eski mesajları yükle
                    </button>
                  )}
                  {timelineMessages.map((message, index) => (
                    <Fragment key={message.id}>
                      {(index === 0 ||
                        messageDayKey(timelineMessages[index - 1]!.sentAt) !==
                          messageDayKey(message.sentAt)) && (
                        <div className="date-divider">
                          <span>{formatMessageDay(message.sentAt)}</span>
                        </div>
                      )}
                      {message.id === unreadBoundaryId && (
                        <div className="unread-divider">
                          <span>Okunmamış mesajlar</span>
                        </div>
                      )}
                      <article
                        id={`message-${message.id}`}
                        className={`${
                          message.direction === "outbound"
                            ? `message outgoing ${message.status}`
                            : "message incoming"
                        } group-${messageGroupPosition(
                          timelineMessages,
                          index,
                        )}${message.attachments?.length ? " has-attachment" : ""}${
                          activeSearchMessageId === message.id
                            ? " search-highlight"
                            : ""
                        }`}
                      >
                        {typeof message.metadata.replyToMessageId ===
                          "string" &&
                          (() => {
                            const quoted = messages.find(
                              (candidate) =>
                                candidate.providerMessageId ===
                                  message.metadata.replyToMessageId ||
                                candidate.id ===
                                  message.metadata.replyToMessageId,
                            );
                            return quoted ? (
                              <div className="quoted-message">
                                <strong>{quoted.senderName}</strong>
                                <span>
                                  <WhatsAppFormattedText
                                    text={
                                      messageDisplayBody(
                                        quoted.body,
                                        quoted.metadata,
                                        messages,
                                      ) || `[${quoted.type}]`
                                    }
                                  />
                                </span>
                              </div>
                            ) : null;
                          })()}
                        {message.type === "interactive" ? (
                          <div className="interactive-card">
                            <strong>
                              {String(
                                (
                                  message.metadata as {
                                    interactive?: { body?: { text?: unknown } };
                                    button_reply?: { title?: unknown };
                                    list_reply?: {
                                      title?: unknown;
                                      description?: unknown;
                                    };
                                  }
                                ).interactive?.body?.text ??
                                  (
                                    message.metadata as {
                                      button_reply?: { title?: unknown };
                                      list_reply?: {
                                        title?: unknown;
                                        description?: unknown;
                                      };
                                    }
                                  ).button_reply?.title ??
                                  (
                                    message.metadata as {
                                      list_reply?: {
                                        title?: unknown;
                                        description?: unknown;
                                      };
                                    }
                                  ).list_reply?.title ??
                                  (message.body !== "[interactive]"
                                    ? message.body
                                    : "Interactive mesaj"),
                              )}
                            </strong>
                            {Array.isArray(
                              (
                                message.metadata as {
                                  interactive?: {
                                    action?: { buttons?: unknown[] };
                                  };
                                }
                              ).interactive?.action?.buttons,
                            ) && (
                              <div className="interactive-options">
                                {(
                                  (
                                    message.metadata as {
                                      interactive?: {
                                        action?: {
                                          buttons?: Array<{
                                            reply?: { title?: unknown };
                                          }>;
                                        };
                                      };
                                    }
                                  ).interactive?.action?.buttons ?? []
                                ).map((button, index) => (
                                  <span key={index}>
                                    {String(button.reply?.title ?? "Seçenek")}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : message.type === "location" ? (
                          <div className="location-card">
                            <MapPin size={20} />
                            <div>
                              <strong>Konum</strong>
                              <span>
                                {String(
                                  (message.metadata as { name?: unknown })
                                    .name ?? "Paylaşılan konum",
                                )}
                              </span>
                              <small>
                                {String(
                                  (message.metadata as { latitude?: unknown })
                                    .latitude ?? "",
                                )}
                                ,{" "}
                                {String(
                                  (message.metadata as { longitude?: unknown })
                                    .longitude ?? "",
                                )}
                              </small>
                            </div>
                          </div>
                        ) : (message.type === "contact" ||
                            message.type === "contacts") &&
                          Array.isArray(message.metadata) ? (
                          <div className="contact-card">
                            <UserRound size={20} />
                            <div>
                              <strong>Kişi</strong>
                              <span>
                                {String(
                                  (
                                    message.metadata as unknown as Array<{
                                      name?: {
                                        formatted_name?: unknown;
                                        formatted?: unknown;
                                      };
                                    }>
                                  )[0]?.name?.formatted_name ??
                                    (
                                      message.metadata as unknown as Array<{
                                        name?: { formatted?: unknown };
                                      }>
                                    )[0]?.name?.formatted ??
                                    "Paylaşılan kişi",
                                )}
                              </span>
                            </div>
                          </div>
                        ) : (
                          shouldRenderMessageBody(
                            message.body,
                            message.type,
                            message.attachments.length,
                          ) && (
                            <p className="message-text">
                              <WhatsAppFormattedText
                                text={
                                  messageDisplayBody(
                                    message.body,
                                    message.metadata,
                                    messages,
                                  ) || `[${message.type}]`
                                }
                              />
                            </p>
                          )
                        )}
                        {message.attachments?.length > 0 && (
                          <div
                            className={
                              message.attachments.length > 1
                                ? "message-attachments multiple"
                                : "message-attachments"
                            }
                          >
                            {message.attachments.map((attachment) => (
                              <MessageAttachmentCard
                                key={attachment.id}
                                attachment={attachment}
                                downloadable={isAttachmentDownloadable(
                                  attachment,
                                )}
                                thumbnailUrl={thumbnailUrls[attachment.id]}
                                mediaUrl={mediaUrls[attachment.id]}
                                activeAudioId={playingAudioId}
                                onActiveAudioChange={setPlayingAudioId}
                                onDownload={(id) => void downloadAttachment(id)}
                              />
                            ))}
                          </div>
                        )}
                        {reactionsByTarget[
                          message.providerMessageId ?? message.id
                        ]?.length ? (
                          <div
                            className="message-reaction-badges"
                            aria-label="Bu mesaja verilen reactionlar"
                          >
                            {reactionsByTarget[
                              message.providerMessageId ?? message.id
                            ]!.map((emoji, index) => (
                              <button
                                type="button"
                                key={`${emoji}-${index}`}
                                title="Reaction kaldır"
                                onClick={() =>
                                  void sendReaction(message.id, "")
                                }
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {message.errorMessage && (
                          <div className="message-error-row">
                            <p className="message-error">
                              {message.errorMessage}
                            </p>
                            {message.direction === "outbound" && (
                              <button
                                type="button"
                                onClick={() => void retryFailedMessage(message)}
                                disabled={!windowOpen}
                              >
                                <RotateCcw size={13} />
                                Tekrar dene
                              </button>
                            )}
                          </div>
                        )}
                        <div className="message-reaction-area">
                          {message.body.trim() && (
                            <button
                              type="button"
                              className="message-copy-trigger"
                              aria-label={
                                copiedMessageId === message.id
                                  ? "Mesaj kopyalandı"
                                  : "Mesajı kopyala"
                              }
                              onClick={() => void copyMessage(message)}
                            >
                              <Copy size={15} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="message-reply-trigger"
                            aria-label="Mesajı yanıtla"
                            onClick={() => setReplyToMessage(message)}
                          >
                            <Reply size={16} />
                          </button>
                          <button
                            type="button"
                            className="message-reaction-trigger"
                            aria-label="Reaction ekle"
                            onClick={() =>
                              setReactionMessageId((current) =>
                                current === message.id ? null : message.id,
                              )
                            }
                          >
                            <Smile size={18} />
                          </button>
                          {reactionMessageId === message.id && (
                            <div className="reaction-picker" role="menu">
                              {REACTION_EMOJIS.map((emoji) => (
                                <button
                                  type="button"
                                  key={emoji}
                                  role="menuitem"
                                  onClick={() =>
                                    void sendReaction(message.id, emoji)
                                  }
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {(messageGroupPosition(timelineMessages, index) ===
                          "single" ||
                          messageGroupPosition(timelineMessages, index) ===
                            "last") && (
                          <footer>
                            <span>{message.senderName}</span>
                            <time>
                              {new Date(message.sentAt).toLocaleTimeString(
                                "tr",
                                {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )}
                            </time>
                            {message.direction === "outbound" &&
                              (message.status === "read" ? (
                                <CheckCheck
                                  className="message-status read"
                                  size={14}
                                  aria-label="Okundu"
                                />
                              ) : message.status === "delivered" ? (
                                <CheckCheck
                                  className="message-status delivered"
                                  size={14}
                                  aria-label="Teslim edildi"
                                />
                              ) : message.status === "pending" ? (
                                <Clock3
                                  className="message-status pending"
                                  size={13}
                                  aria-label="Gönderiliyor"
                                />
                              ) : message.status === "failed" ? (
                                <WifiOff
                                  className="message-status failed"
                                  size={13}
                                  aria-label="Gönderilemedi"
                                />
                              ) : (
                                <Check
                                  className="message-status sent"
                                  size={13}
                                  aria-label="Gönderildi"
                                />
                              ))}
                          </footer>
                        )}
                      </article>
                    </Fragment>
                  ))}
                  {!nearBottom && (
                    <button
                      type="button"
                      className="scroll-to-latest"
                      onClick={scrollToLatest}
                    >
                      <ArrowDown size={17} />
                      {newMessageCount > 0 && <b>{newMessageCount}</b>}
                      <span className="sr-only">En yeni mesaja git</span>
                    </button>
                  )}
                </div>
                <div
                  className={
                    composerDragActive ? "composer drag-active" : "composer"
                  }
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setComposerDragActive(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    )
                      setComposerDragActive(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setComposerDragActive(false);
                    const file = event.dataTransfer.files?.[0];
                    if (file) chooseComposerFile(file);
                  }}
                >
                  {composerDragActive && (
                    <div className="composer-drop-overlay" aria-hidden="true">
                      <Paperclip size={22} />
                      <strong>Dosyayı buraya bırakın</strong>
                      <span>Fotoğraf, video, ses veya belge</span>
                    </div>
                  )}
                  {replyToMessage && (
                    <div className="reply-preview">
                      <div>
                        <strong>{replyToMessage.senderName}</strong>
                        <span>
                          {replyToMessage.body || `[${replyToMessage.type}]`}
                        </span>
                      </div>
                      <button
                        type="button"
                        aria-label="Yanıtı iptal et"
                        onClick={() => setReplyToMessage(null)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}
                  {aiApproval && (
                    <div className="reply-preview" role="status">
                      <div>
                        <strong>
                          🤖 AI taslak yanıt (onay bekliyor)
                          {formatConfidence(aiApproval.confidence)
                            ? ` · Güven ${formatConfidence(aiApproval.confidence)}`
                            : ""}
                        </strong>
                        {aiApproval.expanded ? (
                          <p>{aiApproval.text}</p>
                        ) : (
                          <span>{aiApproval.text}</span>
                        )}
                        <span className="inline-actions">
                          <button
                            type="button"
                            onClick={() =>
                              setAiApprovalState(
                                (current) =>
                                  current && {
                                    ...current,
                                    expanded: !current.expanded,
                                  },
                              )
                            }
                          >
                            {aiApproval.expanded ? "Daralt" : "Tamamını gör"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void approveAiDraft()}
                          >
                            Onayla ve gönder
                          </button>
                          <button type="button" onClick={editAiDraft}>
                            Düzenle
                          </button>
                          <button
                            type="button"
                            onClick={() => void rejectAiDraft()}
                          >
                            Reddet
                          </button>
                        </span>
                      </div>
                    </div>
                  )}
                  {aiHandoff && (
                    <div className="reply-preview" role="status">
                      <div>
                        <strong>AI insan devri önerdi</strong>
                        <span>
                          {aiHandoff.reason ||
                            "Bu konuşma insan yanıtı bekliyor."}
                        </span>
                        {aiHandoff.suggestedText && (
                          <span className="inline-actions">
                            <button
                              type="button"
                              onClick={() => {
                                setDraft(aiHandoff.suggestedText ?? "");
                                requestAnimationFrame(() =>
                                  composerInput.current?.focus(),
                                );
                              }}
                            >
                              Önerilen metni kullan
                            </button>
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label="Devir uyarısını kapat"
                        onClick={() => {
                          aiDismissedRuns.current.add(aiHandoff.runId);
                          setAiHandoffState(null);
                        }}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}
                  {aiSuggestion && (
                    <div className="reply-preview" role="status">
                      <div>
                        <strong>
                          AI önerisi · {aiSuggestion.agentName}
                          {aiSuggestion.sources.length > 0 && (
                            <span
                              className="muted"
                              title={aiSuggestion.sources
                                .map(
                                  (source) =>
                                    `${source.title} (%${Math.round(source.score * 100)})`,
                                )
                                .join(", ")}
                            >
                              {" "}
                              · Kaynak:{" "}
                              {aiSuggestion.sources
                                .slice(0, 2)
                                .map((source) => source.title)
                                .join(", ")}
                              {aiSuggestion.sources.length > 2 &&
                                ` +${aiSuggestion.sources.length - 2}`}
                            </span>
                          )}
                        </strong>
                        <span className="inline-actions">
                          <button
                            type="button"
                            disabled={aiGenerating}
                            onClick={() => {
                              sendAiFeedback(aiSuggestion.runId, "regenerated");
                              void generateAiReply();
                            }}
                          >
                            Yenile
                          </button>
                          <button
                            type="button"
                            disabled={aiGenerating}
                            onClick={() => void generateAiReply("shorter")}
                          >
                            Kısalt
                          </button>
                          <button
                            type="button"
                            disabled={aiGenerating}
                            onClick={() => void generateAiReply("longer")}
                          >
                            Uzat
                          </button>
                          <button
                            type="button"
                            disabled={aiGenerating}
                            onClick={() => void generateAiReply("friendlier")}
                          >
                            Samimi
                          </button>
                          <button
                            type="button"
                            disabled={aiGenerating}
                            onClick={() => void generateAiReply("professional")}
                          >
                            Resmi
                          </button>
                          <button
                            type="button"
                            aria-label="İyi öneri"
                            onClick={() =>
                              sendAiFeedback(aiSuggestion.runId, "rated_good")
                            }
                          >
                            👍
                          </button>
                          <button
                            type="button"
                            aria-label="Kötü öneri"
                            onClick={() =>
                              sendAiFeedback(aiSuggestion.runId, "rated_bad")
                            }
                          >
                            👎
                          </button>
                        </span>
                      </div>
                      <button
                        type="button"
                        aria-label="AI önerisini kapat"
                        onClick={() => setAiSuggestionState(null)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}
                  {interactiveMode !== "none" && (
                    <div className="interactive-composer">
                      <input
                        value={interactiveBody}
                        onChange={(event) =>
                          setInteractiveBody(event.target.value)
                        }
                        placeholder="Mesaj metni"
                      />
                      <input
                        value={interactiveOptions}
                        onChange={(event) =>
                          setInteractiveOptions(event.target.value)
                        }
                        placeholder={
                          interactiveMode === "button"
                            ? "Butonlar (virgülle ayırın, en fazla 3)"
                            : "Liste seçenekleri (virgülle ayırın)"
                        }
                      />
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void sendInteractive()}
                      >
                        Interactive gönder
                      </button>
                    </div>
                  )}
                  {quickMenuState.open && (
                    <div className="quick-menu" role="listbox">
                      {quickMenuState.items.map((reply, index) => (
                        <button
                          key={reply.id}
                          type="button"
                          role="option"
                          aria-selected={index === quickMenuIndex}
                          onMouseEnter={() => setQuickMenuIndex(index)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void chooseQuick(reply)}
                        >
                          <span>
                            <strong>/{reply.shortcut}</strong>
                            <span>{reply.title}</span>
                          </span>
                          <small>
                            {reply.favorite ? "★ " : ""}
                            {reply.category_name ?? reply.scope} ·{" "}
                            {reply.language}
                          </small>
                        </button>
                      ))}
                      {quickMenuState.items.length === 0 && (
                        <span>Aramanızla eşleşen hazır cevap yok.</span>
                      )}
                    </div>
                  )}
                  {voiceState !== "idle" && (
                    <div className="composer-voice-state">
                      {voiceState === "preview" ? (
                        <span className="inline-actions voice-preview-bar">
                          <audio
                            controls
                            aria-label="Kaydedilen sesli mesaj önizlemesi"
                            src={voicePreviewUrl ?? undefined}
                          />
                          <button
                            aria-label="Ses kaydını gönder"
                            onClick={() => void sendVoiceRecording()}
                          >
                            <Send size={16} />
                          </button>
                          <button
                            aria-label="Ses kaydını sil"
                            onClick={cancelVoiceRecording}
                          >
                            <X size={16} />
                          </button>
                        </span>
                      ) : (
                        <span
                          className="inline-actions voice-recorder-bar"
                          aria-live="polite"
                        >
                          <span
                            className="recording-indicator"
                            aria-hidden="true"
                          />
                          <strong>{formatAudioTime(voiceSeconds)}</strong>
                          <button
                            aria-label={
                              voiceState === "paused"
                                ? "Ses kaydına devam et"
                                : "Ses kaydını duraklat"
                            }
                            onClick={pauseOrResumeVoice}
                          >
                            {voiceState === "paused" ? (
                              <Play size={16} />
                            ) : (
                              <Pause size={16} />
                            )}
                          </button>
                          <button
                            aria-label="Ses kaydını bitir"
                            onClick={stopVoiceRecording}
                          >
                            <Square size={16} />
                          </button>
                          <button
                            aria-label="Ses kaydını iptal et"
                            onClick={cancelVoiceRecording}
                          >
                            <X size={16} />
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) chooseComposerFile(file);
                    }}
                  />
                  {composerToolsOpen && (
                    <div
                      id="composer-action-menu"
                      className="composer-action-menu"
                      role="menu"
                      aria-label="Mesaj araçları"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!windowOpen}
                        onClick={() => {
                          setComposerToolsOpen(false);
                          setComposerEmojiOpen(true);
                        }}
                      >
                        <span className="composer-action-icon">
                          <Smile size={20} />
                        </span>
                        <span>Emoji ekle</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={uploading}
                        onClick={() => {
                          setComposerToolsOpen(false);
                          fileInput.current?.click();
                        }}
                      >
                        <span className="composer-action-icon">
                          <Paperclip size={20} />
                        </span>
                        <span>Bilgisayardan yükle</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setComposerToolsOpen(false);
                          setFilePickerCategory("all");
                          setFilePickerOpen(true);
                        }}
                      >
                        <span className="composer-action-icon">
                          <HardDrive size={20} />
                        </span>
                        <span>Google Drive&apos;dan seç</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setComposerToolsOpen(false);
                          setFilePickerCategory("patient");
                          setFilePickerOpen(true);
                        }}
                      >
                        <span className="composer-action-icon">
                          <FolderOpen size={20} />
                        </span>
                        <span>Hasta dosyalarından seç</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setComposerToolsOpen(false);
                          setFilePickerCategory("treatment_plans");
                          setFilePickerOpen(true);
                        }}
                      >
                        <span className="composer-action-icon">
                          <BookOpenText size={20} />
                        </span>
                        <span>Tedavi planları</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setComposerToolsOpen(false);
                          setFilePickerCategory("recent");
                          setFilePickerOpen(true);
                        }}
                      >
                        <span className="composer-action-icon">
                          <Clock3 size={20} />
                        </span>
                        <span>Son kullanılanlar</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setComposerToolsOpen(false);
                          setFilePickerCategory("documents");
                          setFilePickerOpen(true);
                        }}
                      >
                        <span className="composer-action-icon">
                          <FileText size={20} />
                        </span>
                        <span>Hazır belgeler</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setComposerToolsOpen(false);
                          if (!windowOpen) {
                            setOperationError(
                              "24 saatlik müşteri hizmeti penceresi kapalı. Onaylı bir Meta şablonu gönderin.",
                            );
                            setShowTemplate(true);
                            return;
                          }
                          setQuickMenuForced((open) => !open);
                          requestAnimationFrame(() =>
                            composerInput.current?.focus(),
                          );
                        }}
                      >
                        <span className="composer-action-icon">
                          <MessagesSquare size={20} />
                        </span>
                        <span>Hazır cevaplar</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={aiGenerating || !selectedId}
                        onClick={() => {
                          setComposerToolsOpen(false);
                          void generateAiReply();
                        }}
                      >
                        <span className="composer-action-icon">
                          <Sparkles size={20} />
                        </span>
                        <span>AI yanıt öner</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setComposerToolsOpen(false);
                          setShowTemplate(true);
                        }}
                      >
                        <span className="composer-action-icon">
                          <BookOpenText size={20} />
                        </span>
                        <span>Şablon mesaj</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!windowOpen}
                        className={interactiveMode === "button" ? "active" : ""}
                        onClick={() => {
                          setComposerToolsOpen(false);
                          setInteractiveMode(
                            interactiveMode === "button" ? "none" : "button",
                          );
                        }}
                      >
                        <span className="composer-action-icon">
                          <MessageCircleMore size={20} />
                        </span>
                        <span>Butonlu mesaj</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!windowOpen}
                        className={interactiveMode === "list" ? "active" : ""}
                        onClick={() => {
                          setComposerToolsOpen(false);
                          setInteractiveMode(
                            interactiveMode === "list" ? "none" : "list",
                          );
                        }}
                      >
                        <span className="composer-action-icon">
                          <Rows3 size={20} />
                        </span>
                        <span>Liste mesajı</span>
                      </button>
                    </div>
                  )}
                  {composerEmojiOpen && (
                    <div
                      ref={composerEmojiRef}
                      className="composer-emoji-picker"
                      role="menu"
                      aria-label="Mesaja emoji ekle"
                    >
                      {["😀", "😂", "😍", "👍", "🙏", "🎉", "❤️", "🦷"].map(
                        (emoji) => (
                          <button
                            type="button"
                            role="menuitem"
                            aria-label={`${emoji} emojisini ekle`}
                            key={emoji}
                            onClick={() => {
                              const cursor = composerCursor ?? draft.length;
                              const next = `${draft.slice(0, cursor)}${emoji}${draft.slice(cursor)}`;
                              setDraft(next);
                              setComposerCursor(cursor + emoji.length);
                              setComposerEmojiOpen(false);
                              requestAnimationFrame(() => {
                                composerInput.current?.focus();
                                composerInput.current?.setSelectionRange(
                                  cursor + emoji.length,
                                  cursor + emoji.length,
                                );
                              });
                            }}
                          >
                            <span aria-hidden="true">{emoji}</span>
                          </button>
                        ),
                      )}
                    </div>
                  )}
                  <div className="composer-row">
                    <button
                      type="button"
                      className={`composer-plus${composerToolsOpen ? " active" : ""}`}
                      aria-label={
                        composerToolsOpen
                          ? "Mesaj araçlarını kapat"
                          : "Mesaj araçlarını aç"
                      }
                      aria-expanded={composerToolsOpen}
                      aria-controls="composer-action-menu"
                      onClick={() => setComposerToolsOpen((open) => !open)}
                    >
                      <Plus size={24} />
                    </button>
                    <span className="composer-divider" aria-hidden="true" />
                    <textarea
                      ref={composerInput}
                      rows={1}
                      aria-label="Mesaj"
                      value={draft}
                      onChange={(event) => {
                        setDraft(event.target.value);
                        setComposerCursor(event.target.selectionStart);
                        setQuickMenuIndex(0);
                      }}
                      onSelect={(event) =>
                        setComposerCursor(event.currentTarget.selectionStart)
                      }
                      disabled={!windowOpen}
                      onKeyDown={(event) => {
                        if (quickMenuState.open) {
                          if (event.key === "ArrowDown") {
                            event.preventDefault();
                            setQuickMenuIndex((index) =>
                              quickMenuState.items.length
                                ? (index + 1) % quickMenuState.items.length
                                : 0,
                            );
                            return;
                          }
                          if (event.key === "ArrowUp") {
                            event.preventDefault();
                            setQuickMenuIndex((index) =>
                              quickMenuState.items.length
                                ? (index - 1 + quickMenuState.items.length) %
                                  quickMenuState.items.length
                                : 0,
                            );
                            return;
                          }
                          if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            quickMenuState.items[quickMenuIndex]
                          ) {
                            event.preventDefault();
                            void chooseQuick(
                              quickMenuState.items[quickMenuIndex],
                            );
                            return;
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setQuickMenuForced(false);
                            return;
                          }
                        }
                        if (shouldSubmitComposer(event.nativeEvent)) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                      placeholder={
                        windowOpen
                          ? "Bir mesaj yazın…"
                          : "24 saatlik pencere kapalı — şablon seçin"
                      }
                    />
                    <div className="composer-trailing-actions">
                      <button
                        className="icon-button"
                        aria-label="AI yanıt öner"
                        title="AI yanıt öner"
                        disabled={aiGenerating || !selectedId}
                        onClick={() => void generateAiReply()}
                      >
                        <Sparkles size={18} />
                      </button>
                      {voiceSupported === false ? (
                        <span className="sr-only">
                          Ses kaydı desteklenmiyor; ses dosyası ekleyin.
                        </span>
                      ) : (
                        voiceState === "idle" && (
                          <button
                            className="icon-button"
                            aria-label="Ses kaydını başlat"
                            title="Ses kaydını başlat"
                            disabled={uploading || !voiceSupported}
                            onClick={() => void startVoiceRecording()}
                          >
                            <Mic size={18} />
                          </button>
                        )
                      )}
                      {uploading && (
                        <span className="composer-uploading" aria-live="polite">
                          Yükleniyor…
                        </span>
                      )}
                      <button
                        className="send-button"
                        aria-label="Mesajı gönder"
                        title="Gönder"
                        onClick={() => void send()}
                        disabled={
                          channelSwitching || !windowOpen || !draft.trim()
                        }
                      >
                        <Send size={18} />
                      </button>
                    </div>
                  </div>
                  <div className="composer-meta" aria-hidden="true">
                    <span>
                      {aiGenerating
                        ? "AI yanıt hazırlanıyor…"
                        : "Enter ile gönder · Shift + Enter ile yeni satır"}
                    </span>
                    <span>{draft.length} karakter</span>
                  </div>
                </div>
                {showTemplate && (
                  <div className="modal-backdrop">
                    <div className="modal-card template-picker">
                      <h2>WhatsApp şablonu seç</h2>
                      {!selectedTemplate ? (
                        <>
                          <label className="management-search">
                            <Search size={16} />
                            <input
                              placeholder="Şablon ara"
                              aria-label="Şablon ara"
                            />
                          </label>
                          <div className="template-list">
                            {templates.map((template) => (
                              <button
                                key={template.id}
                                onClick={() => void chooseTemplate(template)}
                              >
                                <span>
                                  <strong>{template.name}</strong>
                                  <small>
                                    {template.language} · {template.category}
                                  </small>
                                </span>
                                <p>{template.body_text}</p>
                              </button>
                            ))}
                            {templates.length === 0 && (
                              <div className="empty-state">
                                Bu kanal için approved şablon yok.
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <button
                            className="back-link"
                            onClick={() => setSelectedTemplate(null)}
                          >
                            ← Şablonlara dön
                          </button>
                          <div className="phone-preview">
                            <strong>{selectedTemplate.name}</strong>
                            <p>{selectedTemplate.body_text}</p>
                          </div>
                          {Object.keys(templateVariables).map((key) => (
                            <label key={key}>
                              {key}
                              <input
                                value={templateVariables[key] ?? ""}
                                onChange={(event) =>
                                  setTemplateVariables((values) => ({
                                    ...values,
                                    [key]: event.target.value,
                                  }))
                                }
                              />
                            </label>
                          ))}
                        </>
                      )}
                      <div className="modal-actions">
                        <button
                          onClick={() => {
                            setShowTemplate(false);
                            setSelectedTemplate(null);
                          }}
                        >
                          Vazgeç
                        </button>
                        {selectedTemplate && (
                          <button
                            className="primary-button"
                            disabled={Object.values(templateVariables).some(
                              (value) => !value.trim(),
                            )}
                            onClick={() => void sendTemplate()}
                          >
                            Template gönder
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="inbox-state">Bir konuşma seçin.</div>
            )}
          </section>
          {pendingComposerFile && (
            <div
              className="inbox-file-picker composer-file-mode"
              role="dialog"
              aria-modal="true"
              aria-label="Dosya işlemini seç"
            >
              <header>
                <div>
                  <strong>{pendingComposerFile.name}</strong>
                  <span>
                    {fileUploadStage === "idle" && "Bu dosya için işlemi seçin"}
                    {fileUploadStage === "downloading" && "İndiriliyor…"}
                    {fileUploadStage === "validating" && "Doğrulanıyor…"}
                    {fileUploadStage === "uploading" && "Drive’a yükleniyor…"}
                    {fileUploadStage === "ready" && "Hazır"}
                    {fileUploadStage === "failed" && "Başarısız"}
                    {fileUploadStage === "retrying" && "Tekrar deneniyor…"}
                  </span>
                </div>
                <button
                  aria-label="Dosya işlemini kapat"
                  disabled={uploading}
                  onClick={() => setPendingComposerFile(null)}
                >
                  <X size={18} />
                </button>
              </header>
              <div className="composer-file-mode-options">
                <button
                  disabled={uploading}
                  onClick={() => void handleComposerFileMode("whatsapp")}
                >
                  <Send size={19} />
                  <span>
                    <strong>Yalnızca WhatsApp ile gönder</strong>
                    <small>Drive’a kalıcı kopya kaydetmez.</small>
                  </span>
                </button>
                <button
                  disabled={uploading}
                  onClick={() =>
                    void handleComposerFileMode("drive_and_whatsapp")
                  }
                >
                  <HardDrive size={19} />
                  <span>
                    <strong>Drive’a kaydet ve WhatsApp ile gönder</strong>
                    <small>
                      Hasta klasörüne yükler, hazır olunca gönderir.
                    </small>
                  </span>
                </button>
                <button
                  disabled={uploading}
                  onClick={() => void handleComposerFileMode("drive_only")}
                >
                  <FolderOpen size={19} />
                  <span>
                    <strong>Yalnızca hasta klasörüne kaydet</strong>
                    <small>WhatsApp mesajı oluşturmaz.</small>
                  </span>
                </button>
              </div>
            </div>
          )}
          {filePickerOpen && (
            <div
              className="inbox-file-picker"
              role="dialog"
              aria-modal="true"
              aria-label="Hasta dosyalarından seç"
            >
              <header>
                <div>
                  <strong>Dosya seç</strong>
                  <span>Drive ve hasta dosyaları</span>
                </div>
                <button
                  aria-label="Dosya seçiciyi kapat"
                  onClick={() => setFilePickerOpen(false)}
                >
                  <X size={18} />
                </button>
              </header>
              <div className="inbox-file-picker-tabs">
                {[
                  ["all", "Tümü"],
                  ["incoming_media", "Medya"],
                  ["xray_cbct", "Röntgenler"],
                  ["treatment_plans", "Tedavi planları"],
                  ["other", "Belgeler"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    className={filePickerCategory === id ? "active" : ""}
                    onClick={() => setFilePickerCategory(id!)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="inbox-file-picker-list">
                {conversationFiles
                  .filter(
                    (file) =>
                      file.status === "READY" &&
                      (filePickerCategory === "all" ||
                        filePickerCategory === "patient" ||
                        filePickerCategory === "recent" ||
                        (filePickerCategory === "documents" &&
                          ![
                            "incoming_media",
                            "intraoral_photos",
                            "xray_cbct",
                          ].includes(file.category)) ||
                        file.category === filePickerCategory),
                  )
                  .sort((left, right) =>
                    filePickerCategory === "recent"
                      ? right.created_at.localeCompare(left.created_at)
                      : 0,
                  )
                  .map((file) => (
                    <button
                      key={file.id}
                      disabled={uploading}
                      onClick={() => void sendStoredFile(file)}
                    >
                      <FileText size={19} />
                      <span>
                        <strong>{file.sanitized_name}</strong>
                        <small>{file.category}</small>
                      </span>
                      <Send size={16} />
                    </button>
                  ))}
                {conversationFiles.length === 0 && (
                  <p>Bu konuşmaya bağlı hazır dosya yok.</p>
                )}
              </div>
              <footer>
                <Link href="/app/files">
                  Tüm Dosyalar ve Belgeler&apos;i aç
                </Link>
              </footer>
            </div>
          )}
          {contactDetailsOpen && (
            <button
              type="button"
              className="contact-drawer-backdrop"
              aria-label="Kişi bilgilerini kapat"
              onClick={() => setContactDetailsOpen(false)}
            />
          )}
          <aside
            ref={contactPanelRef}
            className={
              contactDetailsOpen ? "contact-panel open" : "contact-panel"
            }
            role={
              contactDetailsOpen && contactDrawerModal ? "dialog" : undefined
            }
            aria-modal={
              contactDetailsOpen && contactDrawerModal ? "true" : undefined
            }
            aria-label="Kişi ve CRM bilgileri"
          >
            {selected && (
              <>
                <div className="contact-card">
                  <button
                    type="button"
                    className="contact-drawer-close"
                    aria-label="Kişi bilgilerini kapat"
                    onClick={() => setContactDetailsOpen(false)}
                  >
                    <X size={18} />
                  </button>
                  <ContactAvatar
                    contactName={selected.contactName}
                    initials={selected.avatar}
                    profilePictureUrl={selected.profilePictureUrl}
                    size="large"
                  />
                  <h2>{selected.contactName}</h2>
                  <p>{selected.isGroup ? "WhatsApp grubu" : selected.phone}</p>
                  <span className="contact-channel-badge">
                    <i aria-hidden="true" />
                    {selected.channelName}
                  </span>
                </div>
                {selected.isGroup && (
                  <section className="group-participants-card">
                    <header>
                      <h3>{"Grup kat\u0131l\u0131mc\u0131lar\u0131"}</h3>
                      <span>
                        {visibleGroupParticipants.length} {"ki\u015fi"}
                      </span>
                    </header>
                    {visibleGroupParticipants.length ? (
                      <div className="group-participant-list">
                        {visibleGroupParticipants.map((participant) => {
                          const initials = participant.displayName
                            .split(/\s+/)
                            .map((part) => part[0])
                            .join("")
                            .slice(0, 2)
                            .toUpperCase();
                          return (
                            <div
                              className="group-participant-row"
                              key={
                                participant.phoneNumber ??
                                participant.lid ??
                                participant.jid
                              }
                            >
                              <ContactAvatar
                                contactName={participant.displayName}
                                initials={initials || "WA"}
                                profilePictureUrl={null}
                              />
                              <div>
                                <strong>{participant.displayName}</strong>
                                <span>
                                  {formatGroupParticipantPhone(
                                    participant.phoneNumber,
                                  )}
                                </span>
                              </div>
                              {participant.isAdmin && (
                                <em>{"Y\u00f6netici"}</em>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="group-participants-empty">
                        {
                          "Kat\u0131l\u0131mc\u0131 bilgileri WhatsApp'tan al\u0131n\u0131yor\u2026"
                        }
                      </p>
                    )}
                  </section>
                )}
                <section>
                  <header>
                    <h3>Canlı mesajlaşma</h3>
                  </header>
                  <dl>
                    <div>
                      <dt>Kanal</dt>
                      <dd>{selected.channelName}</dd>
                    </div>
                    <div>
                      <dt>Durum</dt>
                      <dd>{selected.lastProviderStatus}</dd>
                    </div>
                    <div>
                      <dt>Atanan</dt>
                      <dd>{selected.assigneeName ?? "Atanmamış"}</dd>
                    </div>
                  </dl>
                </section>
                <section className="crm-context-card">
                  <header>
                    <h3>Bitrix24 CRM</h3>
                    <button
                      aria-label="CRM bağlamını yenile"
                      onClick={() => void refreshCrm()}
                      disabled={crmLoading}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </header>
                  {crmLoading ? (
                    <p>CRM bağlamı yükleniyor…</p>
                  ) : crmContext?.context ? (
                    <>
                      <div className="crm-source-row">
                        <span
                          className={
                            crmContext.stale
                              ? "status-pill warning"
                              : "status-pill healthy"
                          }
                        >
                          {crmContext.stale ? "Eski cache" : "Güncel"}
                        </span>
                        <small>
                          {crmContext.fetchedAt
                            ? new Date(crmContext.fetchedAt).toLocaleTimeString(
                                "tr",
                              )
                            : "Şimdi"}
                        </small>
                      </div>
                      <dl>
                        <div>
                          <dt>Kayıt</dt>
                          <dd>{crmContext.context.entity.displayName}</dd>
                        </div>
                        <div>
                          <dt>Tür / ID</dt>
                          <dd>
                            {crmContext.context.entity.entityType} #
                            {crmContext.context.entity.externalId}
                          </dd>
                        </div>
                        <div>
                          <dt>Şirket</dt>
                          <dd>{crmContext.context.company ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Pipeline</dt>
                          <dd>
                            {crmContext.context.pipeline ?? "—"} ·{" "}
                            {crmContext.context.stage ?? "—"}
                          </dd>
                        </div>
                        <div>
                          <dt>Sorumlu</dt>
                          <dd>
                            {crmContext.context.responsible?.name ??
                              "Eşlenmemiş"}
                          </dd>
                        </div>
                      </dl>
                    </>
                  ) : crmContext?.link ? (
                    <div className="crm-empty">
                      <p>
                        {crmLoadError ||
                          "Bitrix24 bağlantısı bulundu. CRM bilgileri yükleniyor."}
                      </p>
                      <button onClick={() => void refreshCrm()}>
                        Yeniden dene
                      </button>
                    </div>
                  ) : (
                    <div className="crm-empty">
                      <p>Bitrix24 kaydı henüz eşleşmedi.</p>
                      <button
                        onClick={() =>
                          selected &&
                          apiJson(
                            `/api/v1/conversations/${selected.id}/crm-match`,
                            { method: "POST" },
                          ).then(() => refreshCrm())
                        }
                      >
                        CRM&apos;de eşleştir
                      </button>
                    </div>
                  )}
                </section>
                <section className="contact-files-card">
                  <header>
                    <h3>Dosyalar</h3>
                    <Link href={`/app/files?conversationId=${selected.id}`}>
                      Tümünü gör
                    </Link>
                  </header>
                  <div className="contact-files-tabs">
                    {[
                      ["all", "Tümü"],
                      ["incoming_media", "Medya"],
                      ["intraoral_photos", "Klinik"],
                      ["xray_cbct", "Röntgenler"],
                      ["treatment_plans", "Tedavi planları"],
                      ["documents", "Belgeler"],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        className={contactFileCategory === id ? "active" : ""}
                        onClick={() => setContactFileCategory(id!)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="contact-file-list">
                    {conversationFiles
                      .filter(
                        (file) =>
                          contactFileCategory === "all" ||
                          file.category === contactFileCategory ||
                          (contactFileCategory === "documents" &&
                            ![
                              "incoming_media",
                              "intraoral_photos",
                              "xray_cbct",
                            ].includes(file.category)),
                      )
                      .slice(0, 8)
                      .map((file) => (
                        <article key={file.id}>
                          <FileText size={17} />
                          <div>
                            <strong>{file.sanitized_name}</strong>
                            <small>
                              {file.category} · {file.status}
                            </small>
                          </div>
                          <details className="contact-file-actions">
                            <summary
                              aria-label={`${file.sanitized_name} işlemleri`}
                            >
                              <ChevronDown size={15} />
                            </summary>
                            <div>
                              <button
                                onClick={() =>
                                  void downloadStoredFile(file, true)
                                }
                              >
                                Önizle
                              </button>
                              {file.message_id && (
                                <button
                                  onClick={() => {
                                    setContactDetailsOpen(false);
                                    document
                                      .getElementById(
                                        `message-${file.message_id}`,
                                      )
                                      ?.scrollIntoView({
                                        behavior: "smooth",
                                        block: "center",
                                      });
                                  }}
                                >
                                  Mesaja git
                                </button>
                              )}
                              <button
                                disabled={file.status !== "READY" || uploading}
                                onClick={() => void sendStoredFile(file)}
                              >
                                WhatsApp ile gönder
                              </button>
                              {file.metadata?.webViewLink && (
                                <a
                                  href={file.metadata.webViewLink}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Drive’da aç
                                </a>
                              )}
                              <label>
                                Kategori
                                <select
                                  value={file.category}
                                  onChange={(event) =>
                                    void updateStoredFile(file, {
                                      category: event.target.value,
                                    })
                                  }
                                >
                                  <option value="incoming_media">Medya</option>
                                  <option value="intraoral_photos">
                                    Klinik
                                  </option>
                                  <option value="xray_cbct">Röntgen</option>
                                  <option value="treatment_plans">
                                    Tedavi planı
                                  </option>
                                  <option value="consent_forms">
                                    Onam formu
                                  </option>
                                  <option value="invoices">Fatura</option>
                                  <option value="other">Diğer</option>
                                </select>
                              </label>
                              <button
                                onClick={() => {
                                  const note = window.prompt(
                                    "İç not",
                                    file.metadata?.internalNote ?? "",
                                  );
                                  if (note !== null)
                                    void updateStoredFile(file, { note });
                                }}
                              >
                                Not ekle/düzenle
                              </button>
                              <button
                                onClick={() => {
                                  const treatmentRecordId = window.prompt(
                                    "Tedavi kaydı UUID",
                                    file.metadata?.treatmentRecordId ?? "",
                                  );
                                  if (treatmentRecordId !== null)
                                    void updateStoredFile(file, {
                                      treatmentRecordId:
                                        treatmentRecordId.trim() || null,
                                    });
                                }}
                              >
                                Tedavi kaydına bağla
                              </button>
                              <button
                                onClick={() => void downloadStoredFile(file)}
                              >
                                İndir
                              </button>
                              <button
                                onClick={() => void archiveStoredFile(file)}
                              >
                                Arşivle
                              </button>
                            </div>
                          </details>
                        </article>
                      ))}
                    {conversationFiles.length === 0 && (
                      <p>Bu konuşmaya bağlı dosya yok.</p>
                    )}
                  </div>
                </section>
                <section className="internal-notes">
                  <header>
                    <h3>İç notlar</h3>
                    <span>{notes.length}</span>
                  </header>
                  <div className="note-list">
                    {notes
                      .filter((note) => !note.deleted_at)
                      .map((note) => (
                        <article key={note.id}>
                          <p>{note.body}</p>
                          <small>
                            {note.author_name} ·{" "}
                            {new Date(note.created_at).toLocaleTimeString("tr")}
                          </small>
                        </article>
                      ))}
                  </div>
                  <textarea
                    aria-label="İç not"
                    value={noteDraft}
                    onChange={(event) => setNoteDraft(event.target.value)}
                    placeholder="Yalnızca ekip görür…"
                  />
                  <button
                    disabled={!noteDraft.trim()}
                    onClick={() => void addNote()}
                  >
                    İç not ekle
                  </button>
                </section>
              </>
            )}
          </aside>
          {channelSwitching && (
            <div
              className="channel-switch-overlay"
              role="status"
              aria-live="polite"
            >
              <RefreshCw size={18} aria-hidden="true" />
              <span>Kanal değiştiriliyor…</span>
            </div>
          )}
        </section>
      </main>
      {newConversationOpen && (
        <NewConversationDialog
          channels={newConversationChannels}
          initialChannelId={
            whatsappChannelId !== "all" &&
            newConversationChannels.some(
              (channel) => channel.id === whatsappChannelId,
            )
              ? whatsappChannelId
              : (newConversationChannels[0]?.id ?? "")
          }
          onClose={() => setNewConversationOpen(false)}
          onSubmit={startConversation}
        />
      )}
    </div>
  );
}
