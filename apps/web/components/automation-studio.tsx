"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ListPlus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { apiJson } from "../lib/api";
import {
  analyzeLinearGraph,
  planLinearConnection,
  planLinearReorder,
} from "./automation-studio-graph";
import {
  buildStudioPalette,
  type StudioNodeCatalogEntry,
} from "./automation-studio-catalog";

type NodeCategory = "trigger" | "condition" | "action" | "delay" | "end";
type StudioNode = {
  id: string;
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
};
type StudioEdge = {
  id: string;
  source: string;
  target: string;
  handle?: string;
};
type Catalog = {
  nodes?: StudioNodeCatalogEntry[];
  triggers: Array<{ type: string; label: string; availability: string }>;
  actions: Array<{ type: string; label: string; availability: string }>;
  fields: Array<{ field: string; label: string; availability: string }>;
  operators: Array<{ operator: string; label: string; availability: string }>;
};
type Channel = {
  id: string;
  name: string;
  provider: string;
  platform: string;
  phoneNumber?: string;
  status?: string;
};
type Template = {
  id: string;
  name: string;
  language?: string;
  status?: string;
};
type Label = { id: string; name: string };
type User = {
  id: string;
  full_name?: string;
  email: string;
  is_active: boolean;
  suspended_at?: string | null;
};
type AutomationDetail = {
  id: string;
  name: string;
  status: string;
  trigger: { type: string; config: Record<string, unknown> } | null;
  conditions: Array<{
    field: string;
    operator: string;
    value: unknown;
  }>;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
};
type GraphValidationResponse = {
  data: {
    valid: boolean;
    issues: Array<{ code: string; message: string; nodeId?: string }>;
    compiled: { orderedNodeIds: string[] } | null;
  };
};

const initialNodes: StudioNode[] = [
  {
    id: "trigger-1",
    type: "message.received",
    category: "trigger",
    label: "Mesaj alındı",
    description: "Yeni inbound mesaj",
    x: 350,
    y: 40,
    config: {},
  },
  {
    id: "condition-1",
    type: "message.content_matched",
    category: "condition",
    label: "Mesaj içeriğini analiz et",
    description: "Anahtar kelime veya regex",
    x: 350,
    y: 190,
    config: { field: "text", operator: "contains", value: "" },
  },
  {
    id: "action-1",
    type: "assign_user",
    category: "action",
    label: "Temsilciye ata",
    description: "Uygun temsilciye ata",
    x: 180,
    y: 360,
    config: {},
  },
  {
    id: "end-1",
    type: "end",
    category: "end",
    label: "Akışı tamamla",
    description: "Başka adım yok",
    x: 520,
    y: 360,
    config: {},
  },
];
const initialEdges: StudioEdge[] = [
  { id: "edge-1", source: "trigger-1", target: "condition-1" },
  { id: "edge-2", source: "condition-1", target: "action-1", handle: "true" },
  { id: "edge-3", source: "condition-1", target: "end-1", handle: "false" },
];

const palette = [
  {
    category: "trigger" as const,
    title: "Mesaj olayları",
    items: [
      {
        type: "message.received",
        label: "Mesaj alındı",
        description: "Her yeni inbound mesaj",
      },
      {
        type: "message.delivery_failed",
        label: "Mesaj teslim edilemedi",
        description: "Kalıcı sağlayıcı teslimat hatası",
      },
      {
        type: "group.message.received",
        label: "Grup mesajı alındı",
        description: "WhatsApp Web grubundaki yeni mesaj",
      },
      {
        type: "group.mentioned",
        label: "Grupta kişi etiketlendi",
        description: "Grup mesajındaki @ etiketi",
      },
      {
        type: "group.keyword_matched",
        label: "Grup anahtar kelimesi",
        description: "Grup mesajı metin eşleşmesi",
      },
      {
        type: "conversation.first_inbound_message",
        label: "İlk mesaj geldi",
        description: "Konuşmanın gerçek ilk müşteri mesajı",
      },
      {
        type: "message.media_received",
        label: "Medya alındı",
        description: "Görsel, video veya dosya",
      },
    ],
  },
  {
    category: "condition" as const,
    title: "Koşullar",
    items: [
      {
        type: "message.content_matched",
        label: "Mesaj içeriği eşleşti",
        description: "Kelime, ifade veya regex",
      },
      {
        type: "conversation.status_changed",
        label: "Durum kontrolü",
        description: "Konuşma durumunu değerlendir",
      },
    ],
  },
  {
    category: "delay" as const,
    title: "Zaman & SLA",
    items: [
      {
        type: "delay.duration",
        label: "Süre kadar bekle",
        description: "BullMQ delayed job ile güvenli bekleme",
      },
      {
        type: "sla.first_response_overdue",
        label: "İlk yanıt gecikti",
        description: "Temsilci SLA süresi aşıldı",
      },
    ],
  },
  {
    category: "action" as const,
    title: "Aksiyonlar",
    items: [
      {
        type: "add_label",
        label: "Etiket ekle",
        description: "Contact veya conversation etiketi",
      },
      {
        type: "assign_user",
        label: "Temsilciye ata",
        description: "Uygun kullanıcıya ata",
      },
      {
        type: "send_whatsapp_template",
        label: "Şablon mesaj gönder",
        description: "Transactional outbox üzerinden",
      },
      {
        type: "send_group_message",
        label: "Gruba mesaj gönder",
        description: "WhatsApp Web grubuna güvenli yanıt",
      },
      {
        type: "create_bitrix_task",
        label: "Bitrix24 görevi oluştur",
        description: "Kanalın Bitrix24 eşlemesi üzerinden",
      },
      {
        type: "update_bitrix_record",
        label: "Bitrix24 kaydını güncelle",
        description: "Bağlı Lead veya Fırsat aşaması/özel alanı",
      },
    ],
  },
];

const productionFallbackTypes = new Set([
  "message.received",
  "message.delivery_failed",
  "group.message.received",
  "group.mentioned",
  "group.keyword_matched",
  "add_label",
  "assign_user",
  "send_whatsapp_template",
  "send_group_message",
  "create_bitrix_task",
  "update_bitrix_record",
]);

const fallbackNodeCatalog: StudioNodeCatalogEntry[] = palette.flatMap((group) =>
  group.items
    .filter((item) => productionFallbackTypes.has(item.type))
    .map((item) => ({
      type: item.type,
      version: 1,
      displayName: item.label,
      description: item.description,
      category: group.category === "action" ? "conversation" : group.category,
      availability: "available",
      runtimeCapability: "production",
    })),
);

function nodeColor(category: NodeCategory) {
  return category === "trigger"
    ? "green"
    : category === "condition"
      ? "orange"
      : category === "action"
        ? "blue"
        : category === "delay"
          ? "red"
          : "purple";
}

export function AutomationStudio({ automationId }: { automationId?: string }) {
  const [nodes, setNodes] = useState<StudioNode[]>(
      initialNodes.filter((node) => node.category !== "end"),
    ),
    [edges, setEdges] = useState<StudioEdge[]>(
      initialEdges
        .filter((edge) => edge.target !== "end-1")
        .map(({ handle: _handle, ...edge }) => edge),
    ),
    [selected, setSelected] = useState("trigger-1"),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [channels, setChannels] = useState<Channel[]>([]),
    [channelId, setChannelId] = useState(""),
    [name, setName] = useState("Yeni Lead Karşılama"),
    [status, setStatus] = useState("Taslak"),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [search, setSearch] = useState(""),
    [currentAutomationId, setCurrentAutomationId] = useState(automationId),
    [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(
      null,
    ),
    [connecting, setConnecting] = useState<{
      source: string;
      pointer: { x: number; y: number };
    } | null>(null),
    [mobilePaletteOpen, setMobilePaletteOpen] = useState(false),
    [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]),
    [labels, setLabels] = useState<Label[]>([]),
    [users, setUsers] = useState<User[]>([]),
    [loading, setLoading] = useState(Boolean(automationId));
  const idSequence = useRef(initialNodes.length + initialEdges.length);
  const selectedNode = nodes.find((node) => node.id === selected) ?? nodes[0];
  const triggerNode = nodes.find((node) => node.category === "trigger");
  const graphAnalysis = useMemo(
    () =>
      analyzeLinearGraph(
        nodes.map((node) => node.id),
        edges,
        triggerNode?.id,
      ),
    [edges, nodes, triggerNode?.id],
  );
  const orderedNodes = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const ordered = graphAnalysis.orderedNodeIds
      .map((id) => byId.get(id))
      .filter((node): node is StudioNode => Boolean(node));
    const included = new Set(ordered.map((node) => node.id));
    return [...ordered, ...nodes.filter((node) => !included.has(node.id))];
  }, [graphAnalysis.orderedNodeIds, nodes]);
  const validationErrors = useMemo(() => {
    const issues: string[] = [];
    const triggers = nodes.filter((node) => node.category === "trigger");
    const actions = nodes.filter((node) => node.category === "action");
    if (triggers.length !== 1)
      issues.push("Akışta tam olarak bir tetikleyici olmalıdır.");
    if (!actions.length) issues.push("En az bir aksiyon ekleyin.");
    if (!channelId) issues.push("Aktif bir WhatsApp kanalı seçin.");
    if (graphAnalysis.disconnectedNodeIds.length)
      issues.push(
        `${graphAnalysis.disconnectedNodeIds.length} node akışa bağlı değil.`,
      );
    if (graphAnalysis.issues.includes("cycle"))
      issues.push("Akışta döngü bulunuyor.");
    if (graphAnalysis.issues.includes("multiple_outgoing"))
      issues.push("Bir node birden fazla sonraki adıma bağlanamaz.");
    const orderedCategories = graphAnalysis.orderedNodeIds
      .map((id) => nodes.find((node) => node.id === id)?.category)
      .filter(Boolean);
    if (
      orderedCategories.some(
        (category, index) =>
          category === "condition" &&
          orderedCategories.slice(0, index).includes("action"),
      )
    )
      issues.push("Koşullar aksiyonlardan önce bağlanmalıdır.");
    for (const action of actions) {
      if (
        ["add_label", "remove_label"].includes(action.type) &&
        !action.config.labelId
      )
        issues.push(`${action.label}: etiket seçilmedi.`);
      if (action.type === "assign_user" && !action.config.userId)
        issues.push(`${action.label}: temsilci seçilmedi.`);
      if (action.type === "send_whatsapp_template" && !action.config.templateId)
        issues.push(`${action.label}: onaylı şablon seçilmedi.`);
      if (
        action.type === "send_group_message" &&
        !String(action.config.text ?? "").trim()
      )
        issues.push(`${action.label}: gönderilecek mesaj yazılmadı.`);
      if (
        action.type === "create_bitrix_task" &&
        (!String(action.config.title ?? "").trim() ||
          !/^\d+$/.test(String(action.config.responsibleExternalUserId ?? "")))
      )
        issues.push(
          `${action.label}: başlık ve sayısal Bitrix sorumlu kullanıcı kimliği gerekli.`,
        );
      if (
        action.type === "update_bitrix_record" &&
        (!["lead", "deal"].includes(String(action.config.entityType ?? "")) ||
          (!String(action.config.stageId ?? "").trim() &&
            !String(action.config.customFieldId ?? "").trim()))
      )
        issues.push(
          `${action.label}: kayıt türü ile aşama veya özel alan gerekli.`,
        );
    }
    const trigger = triggers[0];
    if (
      trigger?.type === "group.keyword_matched" &&
      (!Array.isArray(trigger.config.keywords) ||
        trigger.config.keywords.length === 0)
    )
      issues.push(`${trigger.label}: en az bir anahtar kelime yazın.`);
    return issues;
  }, [channelId, graphAnalysis, nodes]);
  const visiblePalette = useMemo(
    () => buildStudioPalette(catalog?.nodes ?? fallbackNodeCatalog, search),
    [catalog?.nodes, search],
  );
  useEffect(() => {
    void apiJson<{ data: Catalog }>("/api/v1/automations/catalog")
      .then((result) => setCatalog(result.data))
      .catch(() => setCatalog(null));
    void apiJson<{ data: Channel[] }>("/api/v1/channels")
      .then((result) => {
        const available = result.data.filter(
          (channel) =>
            channel.platform === "whatsapp" &&
            ["meta", "whatsapp_web", "fake"].includes(channel.provider),
        );
        setChannels(available);
        if (!channelId && available[0]) setChannelId(available[0].id);
      })
      .catch(() => setChannels([]));
    void apiJson<{ data: Label[] }>("/api/v1/labels?status=active&limit=100")
      .then((result) => setLabels(result.data ?? []))
      .catch(() => setLabels([]));
    void apiJson<{ data: User[] }>("/api/v1/users")
      .then((result) =>
        setUsers(
          (result.data ?? []).filter(
            (user) => user.is_active && !user.suspended_at,
          ),
        ),
      )
      .catch(() => setUsers([]));
  }, [channelId]);
  useEffect(() => {
    if (!automationId) return;
    void apiJson<{ data: AutomationDetail }>(
      `/api/v1/automations/${automationId}?version=draft`,
    )
      .then(({ data }) => {
        if (!data.trigger)
          throw new Error("Otomasyon tetikleyicisi bulunamadı.");
        const loadedNodes: StudioNode[] = [
          {
            id: "loaded-trigger",
            type: data.trigger.type,
            category: "trigger",
            label: data.trigger.type,
            description: "Yayınlanabilir tetikleyici",
            x: 350,
            y: 40,
            config: data.trigger.config,
          },
          ...data.conditions.map((condition, index) => ({
            id: `loaded-condition-${index}`,
            type: "condition",
            category: "condition" as const,
            label: "Koşul",
            description: `${condition.field} · ${condition.operator}`,
            x: 350,
            y: 190 + index * 150,
            config: {
              field: condition.field,
              operator: condition.operator,
              value: condition.value,
            },
          })),
          ...data.actions.map((action, index) => ({
            id: `loaded-action-${index}`,
            type: action.type,
            category: "action" as const,
            label: action.type,
            description: "Yapılandırılmış aksiyon",
            x: 350,
            y: 190 + (data.conditions.length + index) * 150,
            config: action.config,
          })),
        ];
        setNodes(loadedNodes);
        setEdges(
          loadedNodes.slice(1).map((node, index) => ({
            id: `loaded-edge-${index}`,
            source: loadedNodes[index]!.id,
            target: node.id,
          })),
        );
        setSelected(loadedNodes[0]!.id);
        setName(data.name);
        setStatus(
          data.status === "active"
            ? "Aktif"
            : data.status === "paused"
              ? "Duraklatıldı"
              : "Taslak",
        );
        const scope =
          data.trigger.config.channelScope &&
          typeof data.trigger.config.channelScope === "object" &&
          !Array.isArray(data.trigger.config.channelScope)
            ? (data.trigger.config.channelScope as Record<string, unknown>)
            : {};
        const loadedChannelId = String(
          data.trigger.config.channelId ??
            (Array.isArray(scope.channelIds) ? scope.channelIds[0] : "") ??
            "",
        );
        if (loadedChannelId) setChannelId(loadedChannelId);
        setNotice("Mevcut taslak yüklendi.");
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Otomasyon yüklenemedi.",
        ),
      )
      .finally(() => setLoading(false));
  }, [automationId]);
  function addNode(
    type: string,
    category: NodeCategory,
    label: string,
    description: string,
  ) {
    idSequence.current += 1;
    const id = `${category}-${idSequence.current}`;
    setNodes((current) => [
      ...current,
      {
        id,
        type,
        category,
        label,
        description,
        x: 330 + (current.length % 2) * 180,
        y: 70 + current.length * 90,
        config: type === "update_bitrix_record" ? { entityType: "lead" } : {},
      },
    ]);
    setSelected(id);
    setMobilePaletteOpen(false);
    setMobileInspectorOpen(true);
  }
  function moveLinearNode(nodeId: string, direction: -1 | 1) {
    const plan = planLinearReorder(
      nodes.map((node) => node.id),
      edges,
      triggerNode?.id,
      nodeId,
      direction,
    );
    if (!plan.valid) return;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const reordered = plan.orderedNodeIds
      .map((id) => byId.get(id))
      .filter((node): node is StudioNode => Boolean(node));
    setNodes((current) =>
      current.map((node) => {
        const position = reordered.findIndex((item) => item.id === node.id);
        return position < 0
          ? node
          : { ...node, x: 350, y: 40 + position * 150 };
      }),
    );
    setEdges(
      reordered.slice(1).map((node, edgeIndex) => ({
        id: `mobile-edge-${reordered[edgeIndex]!.id}-${node.id}`,
        source: reordered[edgeIndex]!.id,
        target: node.id,
      })),
    );
  }
  function canMoveLinearNode(nodeId: string, direction: -1 | 1) {
    return planLinearReorder(
      nodes.map((node) => node.id),
      edges,
      triggerNode?.id,
      nodeId,
      direction,
    ).valid;
  }
  useEffect(() => {
    if (!channelId) return;
    void apiJson<{ data: Template[] }>(
      `/api/v1/channels/${channelId}/templates`,
    )
      .then((result) =>
        setTemplates(
          (result.data ?? []).filter(
            (template) => template.status === "approved",
          ),
        ),
      )
      .catch(() => setTemplates([]));
  }, [channelId]);
  useEffect(() => {
    function cancelConnection(event: KeyboardEvent) {
      if (event.key === "Escape") setConnecting(null);
    }
    window.addEventListener("keydown", cancelConnection);
    return () => window.removeEventListener("keydown", cancelConnection);
  }, []);
  function startDrag(event: React.PointerEvent, node: StudioNode) {
    if ((event.target as HTMLElement).closest(".flow-port")) return;
    const canvas = (event.currentTarget as HTMLElement).parentElement;
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    setDrag({
      id: node.id,
      dx: event.clientX - rect.left - node.x,
      dy: event.clientY - rect.top - node.y,
    });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function moveCanvasPointer(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const pointer = {
      x: event.clientX - rect.left + event.currentTarget.scrollLeft,
      y: event.clientY - rect.top + event.currentTarget.scrollTop,
    };
    if (connecting)
      setConnecting((current) => (current ? { ...current, pointer } : null));
    if (drag)
      setNodes((current) =>
        current.map((node) =>
          node.id === drag.id
            ? {
                ...node,
                x: Math.max(20, pointer.x - drag.dx),
                y: Math.max(20, pointer.y - drag.dy),
              }
            : node,
        ),
      );
  }
  function startConnection(node: StudioNode) {
    if (connecting?.source === node.id) {
      setConnecting(null);
      return;
    }
    setError("");
    setConnecting({
      source: node.id,
      pointer: { x: node.x + 117, y: node.y + 104 },
    });
  }
  function connectTo(target: StudioNode) {
    if (!connecting) return;
    const source = nodes.find((node) => node.id === connecting.source);
    if (target.category === "trigger") {
      setError("Tetikleyici yalnızca akışın başlangıcı olabilir.");
      return;
    }
    if (source?.category === "action" && target.category === "condition") {
      setError("Koşullar aksiyonlardan önce bağlanmalıdır.");
      return;
    }
    const result = planLinearConnection(
      nodes.map((node) => node.id),
      edges,
      connecting.source,
      target.id,
    );
    if (!result.valid) {
      const messages: Record<string, string> = {
        self_link: "Bir node kendisine bağlanamaz.",
        duplicate_edge: "Bu bağlantı zaten mevcut.",
        source_occupied:
          "Kaynak node zaten bağlı. Önce mevcut bağlantıyı kaldırın.",
        target_occupied: "Hedef node zaten başka bir adımdan bağlantı alıyor.",
        cycle: "Bu bağlantı akışta döngü oluşturur.",
        missing_endpoint: "Bağlantı hedefi artık mevcut değil.",
      };
      setError(messages[result.reason] ?? "Bağlantı oluşturulamadı.");
      return;
    }
    const additions = result.add.map((edge) => {
      idSequence.current += 1;
      return { id: `edge-${idSequence.current}`, ...edge };
    });
    setEdges((current) => [
      ...current.filter(
        (edge) =>
          !result.remove.some(
            (removed) =>
              removed.source === edge.source && removed.target === edge.target,
          ),
      ),
      ...additions,
    ]);
    setConnecting(null);
    setNotice(
      result.mode === "append"
        ? "Node bağlantısı oluşturuldu."
        : "Node mevcut akışa otomatik olarak eklendi.",
    );
  }
  function removeSelected() {
    if (!selectedNode) return;
    setNodes((current) =>
      current.filter((node) => node.id !== selectedNode.id),
    );
    setEdges((current) =>
      current.filter(
        (edge) =>
          edge.source !== selectedNode.id && edge.target !== selectedNode.id,
      ),
    );
    setSelected("");
  }
  function edgePath(edge: StudioEdge) {
    const source = nodes.find((node) => node.id === edge.source),
      target = nodes.find((node) => node.id === edge.target);
    if (!source || !target) return "";
    const x1 = source.x + 117,
      y1 = source.y + 72,
      x2 = target.x + 117,
      y2 = target.y;
    const mid = (y1 + y2) / 2;
    return `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
  }
  function previewPath() {
    if (!connecting) return "";
    const source = nodes.find((node) => node.id === connecting.source);
    if (!source) return "";
    const x1 = source.x + 117;
    const y1 = source.y + 72;
    const { x: x2, y: y2 } = connecting.pointer;
    const mid = (y1 + y2) / 2;
    return `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
  }
  function updateSelected(key: string, value: string) {
    if (!selectedNode) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNode.id
          ? { ...node, config: { ...node.config, [key]: value } }
          : node,
      ),
    );
  }
  function updateSelectedValue(key: string, value: unknown) {
    if (!selectedNode) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNode.id
          ? { ...node, config: { ...node.config, [key]: value } }
          : node,
      ),
    );
  }
  function isValidConnectionTarget(node: StudioNode) {
    if (!connecting || node.category === "trigger") return false;
    const source = nodes.find((item) => item.id === connecting.source);
    if (source?.category === "action" && node.category === "condition")
      return false;
    return planLinearConnection(
      nodes.map((item) => item.id),
      edges,
      connecting.source,
      node.id,
    ).valid;
  }
  async function saveDraft() {
    setError("");
    try {
      if (validationErrors.length) throw new Error(validationErrors.join(" "));
      const graphValidation = await apiJson<GraphValidationResponse>(
        "/api/v1/automations/validate-graph",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "linear",
            nodes: nodes.map((node) => ({
              id: node.id,
              type: node.type,
              category: node.category,
              position: { x: node.x, y: node.y },
              config: node.config,
            })),
            edges: edges.map((edge) => ({
              id: edge.id,
              source: edge.source,
              target: edge.target,
            })),
          }),
        },
      );
      if (!graphValidation.data.valid || !graphValidation.data.compiled)
        throw new Error(
          graphValidation.data.issues.map((issue) => issue.message).join(" "),
        );
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const orderedNodes = graphValidation.data.compiled.orderedNodeIds
        .map((id) => nodeById.get(id))
        .filter((node): node is StudioNode => Boolean(node));
      const trigger = orderedNodes.find((node) => node.category === "trigger");
      const actions = orderedNodes.filter((node) => node.category === "action");
      if (!trigger || !actions.length)
        throw new Error("Bir trigger ve en az bir aksiyon ekleyin.");
      const conditions = orderedNodes
        .filter((node) => node.category === "condition")
        .map((node) => ({
          field: String(node.config.field ?? "text"),
          operator: String(node.config.operator ?? "contains"),
          value: node.config.value ?? "",
        }));
      if (!channelId) throw new Error("Önce aktif bir WhatsApp kanalı seçin.");
      const created = await apiJson<{ data: { id: string } }>(
        currentAutomationId
          ? `/api/v1/automations/${currentAutomationId}`
          : "/api/v1/automations",
        {
          method: currentAutomationId ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            description: "Automation Studio akışı",
            trigger: {
              type: trigger.type,
              config: {
                ...trigger.config,
                channelScope: {
                  mode: "selected",
                  channelIds: [channelId],
                  excludedChannelIds: [],
                },
              },
            },
            conditions,
            actions: actions.map((node) => ({
              type: node.type,
              config:
                node.type === "send_whatsapp_template"
                  ? { ...node.config, channelId }
                  : { ...node.config },
            })),
          }),
        },
      );
      const savedId = created.data?.id ? String(created.data.id) : "";
      if (!savedId)
        throw new Error(
          "Otomasyon kaydı oluşturuldu ancak kimlik bilgisi alınamadı.",
        );
      setCurrentAutomationId(savedId);
      setStatus("Taslak kaydedildi");
      setNotice(`Taslak kaydedildi (${savedId.slice(0, 8)}…).`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Taslak kaydedilemedi");
    }
  }
  async function publish() {
    if (validationErrors.length) {
      setError(validationErrors.join(" "));
      return;
    }
    if (!currentAutomationId) {
      setError("Yayınlamak için önce taslağı kaydedin.");
      return;
    }
    try {
      await apiJson(`/api/v1/automations/${currentAutomationId}/publish`, {
        method: "POST",
      });
      setStatus("Aktif");
      setNotice("Akış yayınlandı.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Yayınlama başarısız");
    }
  }
  async function dryRun() {
    if (!currentAutomationId) {
      setError("Test etmek için önce taslağı kaydedin.");
      return;
    }
    setError("");
    try {
      const context = Object.fromEntries(
        nodes
          .filter((node) => node.category === "condition")
          .map((node) => [
            String(node.config.field ?? "text"),
            node.config.value ?? "",
          ]),
      );
      const result = await apiJson<{ data: { matched: boolean } }>(
        `/api/v1/automations/${currentAutomationId}/dry-run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(context),
        },
      );
      setNotice(
        result.data.matched
          ? "Kuru test başarılı: koşullar eşleşti."
          : "Kuru test tamamlandı: koşullar eşleşmedi.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kuru test başarısız.");
    }
  }
  return (
    <AppFrame
      title="Otomasyon Stüdyosu"
      subtitle="Mesaj, konuşma ve SLA olaylarına göre akıllı iş akışları oluşturun."
      actions={
        <Link
          className="subtle-button"
          href="/app/automations"
          aria-label="Otomasyon listesine dön"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Listeye dön
        </Link>
      }
    >
      <div className="studio-shell">
        <header className="studio-header">
          <div>
            <div className="breadcrumb">
              <Link href="/app/automations">Otomasyonlar</Link>
              <span>/</span>
              {name}
            </div>
            <div className="studio-title-row">
              <input
                className="studio-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label="Otomasyon adı"
              />
              <span className={`studio-status ${status.toLowerCase()}`}>
                {status}
              </span>
            </div>
          </div>
          <div className="studio-header-actions">
            <span className="save-state">
              {notice ? `✓ ${notice}` : "Kaydedilmemiş taslak"}
            </span>
            {currentAutomationId && (
              <Link
                className="button secondary"
                href={`/app/automations/${currentAutomationId}/runs`}
              >
                Çalıştırma geçmişi
              </Link>
            )}
            <button className="button secondary" onClick={() => void dryRun()}>
              ▷ Test et
            </button>
            <button
              className="button primary"
              disabled={Boolean(validationErrors.length) || loading}
              onClick={() => void publish()}
            >
              Yayınla
            </button>
          </div>
        </header>
        <nav className="studio-tabs">
          <button className="active">Akış Tasarımı</button>
          {currentAutomationId && (
            <Link href={`/app/automations/${currentAutomationId}/runs`}>
              Çalıştırma geçmişi
            </Link>
          )}
        </nav>
        {error && <div className="notice error">{error}</div>}
        {selectedNode?.category === "action" &&
          selectedNode.type === "send_whatsapp_template" && (
            <div className="notice">
              <label>
                WhatsApp şablonu
                <select
                  value={String(selectedNode.config.templateId ?? "")}
                  onChange={(event) =>
                    updateSelected("templateId", event.target.value)
                  }
                >
                  <option value="">Şablon seçin</option>
                  {templates.map((template) => (
                    <option value={template.id} key={template.id}>
                      {template.name}
                      {template.language ? ` · ${template.language}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={selectedNode.config.requireOptIn === false}
                  onChange={(event) =>
                    setNodes((current) =>
                      current.map((node) =>
                        node.id === selectedNode.id
                          ? {
                              ...node,
                              config: {
                                ...node.config,
                                requireOptIn: !event.target.checked,
                              },
                            }
                          : node,
                      ),
                    )
                  }
                />{" "}
                Testte opt-in kontrolünü atla
              </label>
            </div>
          )}
        <div className="studio-mobile-controls">
          <button
            type="button"
            className="button secondary"
            aria-expanded={mobilePaletteOpen}
            onClick={() => setMobilePaletteOpen(true)}
          >
            <ListPlus size={17} aria-hidden="true" />
            {"Ad\u0131m ekle"}
          </button>
          <button
            type="button"
            className="button secondary"
            aria-expanded={mobileInspectorOpen}
            onClick={() => setMobileInspectorOpen(true)}
          >
            <SlidersHorizontal size={17} aria-hidden="true" />
            {"Ad\u0131m ayarlar\u0131"}
          </button>
        </div>
        <div className="studio-grid">
          <aside
            className={`studio-panel palette-panel${mobilePaletteOpen ? " mobile-open" : ""}`}
          >
            <div className="studio-mobile-sheet-header">
              <span>{"Bile\u015fenler"}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={"Bile\u015fen listesini kapat"}
                onClick={() => setMobilePaletteOpen(false)}
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>
            <h3>Bileşenler</h3>
            <input
              placeholder="Tetikleyici veya aksiyon ara"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />{" "}
            <div className="palette-tabs">
              <span className="active">Tetikleyiciler</span>
              <span>Aksiyonlar</span>
            </div>
            {visiblePalette.map((group) => (
              <section className="palette-group" key={group.title}>
                <h4>{group.title}</h4>
                {group.items.map((item) => (
                  <button
                    className={`palette-item${item.disabled ? " planned" : ""}`}
                    key={item.type}
                    disabled={item.disabled}
                    onClick={() =>
                      addNode(
                        item.type,
                        group.category,
                        item.label,
                        item.description,
                      )
                    }
                  >
                    <span className={`node-icon ${nodeColor(group.category)}`}>
                      ✦
                    </span>
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                      {item.disabled ? <small>Planlanıyor</small> : null}
                    </span>
                    <span className="drag-handle">⋮⋮</span>
                  </button>
                ))}
              </section>
            ))}
          </aside>
          <main className="studio-canvas-wrap">
            <div className="canvas-toolbar">
              <span>
                {nodes.length} adım · {edges.length} bağlantı
              </span>
              <span className="toolbar-spacer" />
              <span>Doğrusal akış</span>
            </div>
            <div
              className="studio-mobile-flow"
              aria-label={"Otomasyon ad\u0131mlar\u0131"}
            >
              {orderedNodes.map((node, index) => (
                <article
                  key={node.id}
                  className={selectedNode?.id === node.id ? "selected" : ""}
                >
                  <button
                    type="button"
                    className="studio-mobile-step-copy"
                    onClick={() => {
                      setSelected(node.id);
                      setMobileInspectorOpen(true);
                    }}
                  >
                    <span className={`node-icon ${nodeColor(node.category)}`}>
                      {"\u2726"}
                    </span>
                    <span>
                      <small>
                        {index + 1}. {"ad\u0131m \u00b7"} {node.category}
                      </small>
                      <strong>{node.label}</strong>
                      <em>{node.description}</em>
                    </span>
                  </button>
                  <div className="studio-mobile-step-actions">
                    <button
                      type="button"
                      aria-label={`${node.label} ad\u0131m\u0131n\u0131 yukar\u0131 ta\u015f\u0131`}
                      title="Sıralama yalnızca dalsız akışlarda değiştirilebilir"
                      disabled={!canMoveLinearNode(node.id, -1)}
                      onClick={() => moveLinearNode(node.id, -1)}
                    >
                      <ChevronUp size={18} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`${node.label} ad\u0131m\u0131n\u0131 a\u015fa\u011f\u0131 ta\u015f\u0131`}
                      title="Sıralama yalnızca dalsız akışlarda değiştirilebilir"
                      disabled={!canMoveLinearNode(node.id, 1)}
                      onClick={() => moveLinearNode(node.id, 1)}
                    >
                      <ChevronDown size={18} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div
              className={`studio-canvas ${connecting ? "connecting" : ""}`}
              onPointerMove={moveCanvasPointer}
              onPointerUp={() => setDrag(null)}
            >
              {connecting && (
                <div className="connection-hint">
                  Hedef node’u seçin · Dolu bağlantıda araya otomatik eklenir
                </div>
              )}
              <svg className="canvas-edges" aria-hidden="true">
                <defs>
                  <marker
                    id="automation-arrow"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                </defs>
                {edges.map((edge) => (
                  <path
                    className="persisted-edge"
                    key={edge.id}
                    d={edgePath(edge)}
                    markerEnd="url(#automation-arrow)"
                    onDoubleClick={() =>
                      setEdges((current) =>
                        current.filter((item) => item.id !== edge.id),
                      )
                    }
                  />
                ))}
                {connecting && (
                  <path className="connection-preview" d={previewPath()} />
                )}
              </svg>
              {nodes.map((node) => (
                <div
                  key={node.id}
                  role="group"
                  tabIndex={0}
                  className={`flow-node ${nodeColor(node.category)} ${selectedNode?.id === node.id ? "selected" : ""} ${graphAnalysis.disconnectedNodeIds.includes(node.id) ? "disconnected" : ""} ${isValidConnectionTarget(node) ? "connection-target" : ""}`}
                  style={{ left: `${node.x}px`, top: `${node.y}px` }}
                  onPointerDown={(event) => startDrag(event, node)}
                  onClick={() =>
                    connecting ? connectTo(node) : setSelected(node.id)
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (connecting) connectTo(node);
                    else setSelected(node.id);
                  }}
                >
                  <span className="flow-index">{nodes.indexOf(node) + 1}</span>
                  <button
                    type="button"
                    className="flow-port input-port"
                    aria-label={`${node.label} node'una bağla`}
                    disabled={!connecting || !isValidConnectionTarget(node)}
                    onClick={(event) => {
                      event.stopPropagation();
                      connectTo(node);
                    }}
                  >
                    <span aria-hidden="true">•</span>
                  </button>
                  <span className="node-icon">✦</span>
                  <span className="flow-copy">
                    <small>
                      {node.category.toUpperCase()} · {node.type}
                    </small>
                    <strong>{node.label}</strong>
                    <em>{node.description}</em>
                  </span>
                  <button
                    type="button"
                    className="flow-port output-port"
                    aria-label={`${node.label} node'undan bağlantı başlat`}
                    aria-pressed={connecting?.source === node.id}
                    title={
                      edges.some((edge) => edge.source === node.id)
                        ? "Yeni node’u mevcut bağlantının arasına ekle"
                        : "Yeni bağlantı başlat"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      startConnection(node);
                    }}
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                </div>
              ))}
            </div>
            <footer className="studio-footer">
              <span className={validationErrors.length ? "" : "ready-dot"}>
                {validationErrors.length ? "!" : "✓"}
              </span>
              <strong>
                {loading
                  ? "Taslak yükleniyor"
                  : validationErrors.length
                    ? "Yapılandırma tamamlanmalı"
                    : "Akış yayına hazır"}
              </strong>
              <span>
                •{" "}
                {validationErrors.length
                  ? validationErrors[0]
                  : `${nodes.length} adım doğrulandı`}
              </span>
              <span className="toolbar-spacer" />
              <button
                className="button secondary"
                disabled={loading}
                onClick={() => void saveDraft()}
              >
                Taslağı kaydet
              </button>
            </footer>
          </main>
          <aside
            className={`studio-panel inspector-panel${mobileInspectorOpen ? " mobile-open" : ""}`}
          >
            <div className="inspector-heading">
              <span
                className={`node-icon ${nodeColor(selectedNode?.category ?? "action")}`}
              >
                ✦
              </span>
              <div>
                <h3>Node ayarları</h3>
                <small>
                  {selectedNode
                    ? `${nodes.indexOf(selectedNode) + 1}. Adım`
                    : "Node seçilmedi"}
                </small>
              </div>
              <button
                type="button"
                className="icon-button studio-mobile-close"
                aria-label={"Ad\u0131m ayarlar\u0131n\u0131 kapat"}
                onClick={() => setMobileInspectorOpen(false)}
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>
            {selectedNode ? (
              <>
                <label>
                  Node adı
                  <input
                    value={selectedNode.label}
                    onChange={(event) =>
                      setNodes((current) =>
                        current.map((node) =>
                          node.id === selectedNode.id
                            ? { ...node, label: event.target.value }
                            : node,
                        ),
                      )
                    }
                  />
                </label>
                {selectedNode.category === "trigger" && (
                  <label>
                    WhatsApp kanalı
                    <select
                      value={channelId}
                      onChange={(event) => setChannelId(event.target.value)}
                    >
                      {channels.map((channel) => (
                        <option value={channel.id} key={channel.id}>
                          {channel.name}
                          {channel.phoneNumber
                            ? ` · ${channel.phoneNumber}`
                            : ""}
                        </option>
                      ))}
                    </select>
                    {!channels.length && (
                      <small className="muted">
                        Aktif WhatsApp Cloud API veya WhatsApp Web kanalı
                        bulunamadı.
                      </small>
                    )}
                  </label>
                )}
                {selectedNode.category !== "condition" && (
                  <label>
                    Tür
                    <select
                      value={selectedNode.type}
                      onChange={(event) =>
                        setNodes((current) =>
                          current.map((node) =>
                            node.id === selectedNode.id
                              ? {
                                  ...node,
                                  type: event.target.value,
                                  config:
                                    event.target.value ===
                                    "update_bitrix_record"
                                      ? { entityType: "lead" }
                                      : {},
                                }
                              : node,
                          ),
                        )
                      }
                    >
                      {(selectedNode.category === "trigger"
                        ? catalog?.triggers
                        : catalog?.actions
                      )
                        ?.filter((item) => item.availability === "available")
                        .map((item) => (
                          <option value={item.type} key={item.type}>
                            {item.label}
                          </option>
                        )) ?? <option>{selectedNode.type}</option>}
                    </select>
                  </label>
                )}
                {selectedNode.category === "condition" && (
                  <>
                    <label>
                      Alan
                      <select
                        value={String(selectedNode.config.field ?? "text")}
                        onChange={(event) =>
                          updateSelected("field", event.target.value)
                        }
                      >
                        {catalog?.fields
                          .filter((item) => item.availability === "available")
                          .map((item) => (
                            <option value={item.field} key={item.field}>
                              {item.label}
                            </option>
                          )) ?? <option value="text">Mesaj metni</option>}
                      </select>
                    </label>
                    <label>
                      Operatör
                      <select
                        value={String(
                          selectedNode.config.operator ?? "contains",
                        )}
                        onChange={(event) =>
                          updateSelected("operator", event.target.value)
                        }
                      >
                        {catalog?.operators
                          .filter((item) => item.availability === "available")
                          .map((item) => (
                            <option value={item.operator} key={item.operator}>
                              {item.label}
                            </option>
                          )) ?? <option value="contains">İçerir</option>}
                      </select>
                    </label>
                    <label>
                      Değer
                      <input
                        value={String(selectedNode.config.value ?? "")}
                        onChange={(event) =>
                          updateSelected("value", event.target.value)
                        }
                        placeholder="implant, fiyat…"
                      />
                    </label>
                  </>
                )}
                {selectedNode.category === "trigger" &&
                  selectedNode.type === "group.keyword_matched" && (
                    <>
                      <label>
                        Anahtar kelimeler
                        <textarea
                          value={
                            Array.isArray(selectedNode.config.keywords)
                              ? selectedNode.config.keywords.join(", ")
                              : ""
                          }
                          onChange={(event) =>
                            updateSelectedValue(
                              "keywords",
                              event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            )
                          }
                          placeholder="randevu, fiyat, acil"
                        />
                      </label>
                      <label>
                        Eşleşme biçimi
                        <select
                          value={String(selectedNode.config.matchMode ?? "any")}
                          onChange={(event) =>
                            updateSelected("matchMode", event.target.value)
                          }
                        >
                          <option value="any">Herhangi biri</option>
                          <option value="all">Tümü</option>
                        </select>
                      </label>
                    </>
                  )}
                {selectedNode.category === "trigger" &&
                  selectedNode.type === "group.mentioned" && (
                    <>
                      <label>
                        Etiketleme kapsamı
                        <select
                          value={String(
                            selectedNode.config.mentionMode ?? "any",
                          )}
                          onChange={(event) =>
                            updateSelected("mentionMode", event.target.value)
                          }
                        >
                          <option value="any">Herhangi bir kişi</option>
                          <option value="selected">
                            Seçili WhatsApp kimlikleri
                          </option>
                        </select>
                      </label>
                      {selectedNode.config.mentionMode === "selected" && (
                        <label>
                          WhatsApp kimlikleri
                          <textarea
                            value={
                              Array.isArray(selectedNode.config.mentionedJids)
                                ? selectedNode.config.mentionedJids.join(", ")
                                : ""
                            }
                            onChange={(event) =>
                              updateSelectedValue(
                                "mentionedJids",
                                event.target.value
                                  .split(",")
                                  .map((value) => value.trim())
                                  .filter(Boolean),
                              )
                            }
                            placeholder="90555...@s.whatsapp.net"
                          />
                        </label>
                      )}
                    </>
                  )}
                {selectedNode.category === "action" &&
                  ["add_label", "remove_label"].includes(selectedNode.type) && (
                    <label>
                      Etiket
                      <select
                        value={String(selectedNode.config.labelId ?? "")}
                        onChange={(event) =>
                          updateSelected("labelId", event.target.value)
                        }
                      >
                        <option value="">Etiket seçin</option>
                        {labels.map((label) => (
                          <option value={label.id} key={label.id}>
                            {label.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                {selectedNode.category === "action" &&
                  selectedNode.type === "assign_user" && (
                    <label>
                      Atanacak temsilci
                      <select
                        value={String(selectedNode.config.userId ?? "")}
                        onChange={(event) =>
                          updateSelected("userId", event.target.value)
                        }
                      >
                        <option value="">Temsilci seçin</option>
                        {users.map((user) => (
                          <option value={user.id} key={user.id}>
                            {user.full_name || user.email}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                {selectedNode.category === "action" &&
                  selectedNode.type === "send_group_message" && (
                    <>
                      <label>
                        Grup yanıtı
                        <textarea
                          value={String(selectedNode.config.text ?? "")}
                          maxLength={4096}
                          onChange={(event) =>
                            updateSelected("text", event.target.value)
                          }
                          placeholder="Mesajınız alındı, ekibimiz ilgileniyor."
                        />
                      </label>
                      <label>
                        Etiketlenecek WhatsApp kimlikleri (isteğe bağlı)
                        <textarea
                          value={
                            Array.isArray(selectedNode.config.mentionedJids)
                              ? selectedNode.config.mentionedJids.join(", ")
                              : ""
                          }
                          onChange={(event) =>
                            updateSelectedValue(
                              "mentionedJids",
                              event.target.value
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            )
                          }
                        />
                      </label>
                    </>
                  )}
                {selectedNode.category === "action" &&
                  selectedNode.type === "create_bitrix_task" && (
                    <>
                      <label>
                        Görev başlığı
                        <input
                          value={String(selectedNode.config.title ?? "")}
                          maxLength={255}
                          onChange={(event) =>
                            updateSelected("title", event.target.value)
                          }
                          placeholder="Grup talebini incele"
                        />
                      </label>
                      <label>
                        Bitrix sorumlu kullanıcı kimliği
                        <input
                          inputMode="numeric"
                          value={String(
                            selectedNode.config.responsibleExternalUserId ?? "",
                          )}
                          onChange={(event) =>
                            updateSelected(
                              "responsibleExternalUserId",
                              event.target.value.replace(/\D/g, ""),
                            )
                          }
                          placeholder="1"
                        />
                      </label>
                      <label>
                        Açıklama (isteğe bağlı)
                        <textarea
                          value={String(selectedNode.config.description ?? "")}
                          maxLength={5000}
                          onChange={(event) =>
                            updateSelected("description", event.target.value)
                          }
                        />
                      </label>
                    </>
                  )}
                {selectedNode.category === "action" &&
                  selectedNode.type === "update_bitrix_record" && (
                    <>
                      <small className="muted">
                        Teslimat hatası akışlarında yalnız müşteri/numara
                        kaynaklı hatalar CRM kaydını günceller. Ödeme, yetki,
                        medya, hız limiti ve 24 saat penceresi güvenli biçimde
                        engellenir.
                      </small>
                      <label>
                        Bitrix kayıt türü
                        <select
                          value={String(
                            selectedNode.config.entityType ?? "lead",
                          )}
                          onChange={(event) =>
                            updateSelected("entityType", event.target.value)
                          }
                        >
                          <option value="lead">Lead (Aday)</option>
                          <option value="deal">Deal (Fırsat)</option>
                        </select>
                      </label>
                      <label>
                        Yeni aşama kimliği (isteğe bağlı)
                        <input
                          value={String(selectedNode.config.stageId ?? "")}
                          maxLength={100}
                          onChange={(event) =>
                            updateSelected("stageId", event.target.value.trim())
                          }
                          placeholder="IN_PROCESS veya C8:NEW"
                        />
                      </label>
                      <label>
                        Özel alan kodu (isteğe bağlı)
                        <input
                          value={String(
                            selectedNode.config.customFieldId ?? "",
                          )}
                          maxLength={71}
                          onChange={(event) =>
                            updateSelected(
                              "customFieldId",
                              event.target.value.toUpperCase().trim(),
                            )
                          }
                          placeholder="UF_CRM_WHATSAPP_STATUS"
                        />
                      </label>
                      <label>
                        Özel alan değeri
                        <input
                          value={String(
                            selectedNode.config.customFieldValue ?? "",
                          )}
                          maxLength={1000}
                          onChange={(event) =>
                            updateSelected(
                              "customFieldValue",
                              event.target.value,
                            )
                          }
                          placeholder="Teslim edilemedi"
                        />
                      </label>
                    </>
                  )}
                {selectedNode.category === "delay" && (
                  <label>
                    Bekleme süresi (dakika)
                    <input
                      type="number"
                      min="1"
                      defaultValue="10"
                      onChange={(event) =>
                        updateSelected("minutes", event.target.value)
                      }
                    />
                  </label>
                )}
                <div className="inspector-actions">
                  <button className="button secondary" onClick={removeSelected}>
                    Node sil
                  </button>
                  <button
                    className="button primary"
                    onClick={() => setNotice("Adım kaydedildi")}
                  >
                    Adımı kaydet
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Düzenlemek için bir node seçin.</p>
            )}
          </aside>
        </div>
      </div>
    </AppFrame>
  );
}
