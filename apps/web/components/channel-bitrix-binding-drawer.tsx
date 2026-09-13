"use client";

import {
  ArrowLeftRight,
  Check,
  CircleAlert,
  Columns3,
  HeartPulse,
  Link2,
  MessageCircle,
  ShieldCheck,
  Unplug,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "../lib/api";

export type ChannelBitrixBinding = {
  id: string;
  integrationConnectionId: string;
  connectorId: string;
  lineId: string;
  status: string;
  settings: OpenChannelsSettings;
  lastEventAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export type BitrixConnectionSummary = {
  id: string;
  name: string;
  portalUrl: string | null;
  status: string;
  authMode?: string;
};

export type ChannelBitrixBindingItem = {
  channelId: string;
  binding: ChannelBitrixBinding | null;
  connection: BitrixConnectionSummary | null;
};

export type BitrixBindingsOverview = {
  bindings: ChannelBitrixBindingItem[];
  connections: BitrixConnectionSummary[];
};

export type ChannelForBitrixSettings = {
  id: string;
  name: string;
  provider: string;
  phoneNumber: string | null;
};

type OpenLine = {
  id: string;
  name: string;
  active: boolean;
  crmEnabled: boolean;
  crmCreate: "lead" | "deal" | "none";
  queueUserIds: string[];
};

type PipelineRow = {
  pipeline_external_id: string;
  pipeline_name: string;
  stage_external_id: string;
  stage_name: string;
};

type OpenChannelsSettings = {
  brixchatChannelId?: string;
  lineId?: string;
  incomingEnabled?: boolean;
  outgoingEnabled?: boolean;
  deliveryStatusSync?: boolean;
  sessionCloseSync?: boolean;
  autoCrmMode?: "disabled" | "lead" | "contact_and_deal";
  crmSourceId?: string;
  pipelineId?: string;
  stageId?: string;
  timelinePolicy?: "per_message" | "session_summary" | "disabled";
};

type OpenChannelsState = {
  bitrix_mode?: "crm_context" | "open_channels" | "both";
  open_channels_settings?: OpenChannelsSettings;
  connector_id?: string;
  bindings?: Array<{
    brixchat_channel_id: string;
    line_id: string;
    settings?: OpenChannelsSettings;
  }>;
};

type BindingChoice = "none" | "existing" | "new";

const defaultSettings: OpenChannelsSettings = {
  incomingEnabled: true,
  outgoingEnabled: true,
  deliveryStatusSync: true,
  sessionCloseSync: true,
  autoCrmMode: "disabled",
  crmSourceId: "WEB",
  timelinePolicy: "session_summary",
};

const flowToggles: Array<{
  key:
    | "incomingEnabled"
    | "outgoingEnabled"
    | "deliveryStatusSync"
    | "sessionCloseSync";
  label: string;
  hint: string;
}> = [
  {
    key: "incomingEnabled",
    label: "Gelen mesajlar",
    hint: "BrixChat → Bitrix24",
  },
  {
    key: "outgoingEnabled",
    label: "Operatör yanıtları",
    hint: "Bitrix24 → BrixChat",
  },
  {
    key: "deliveryStatusSync",
    label: "Teslimat durumu",
    hint: "Mesaj durumlarını eşitle",
  },
  {
    key: "sessionCloseSync",
    label: "Oturum kapanışı",
    hint: "Kapanış durumunu eşitle",
  },
];

function providerLabel(provider: string) {
  return provider === "whatsapp_web"
    ? "WhatsApp Web · Bağlı cihaz"
    : "WhatsApp Cloud API";
}

function bindingStatusLabel(binding: ChannelBitrixBinding | null) {
  if (!binding) return "Bitrix24'e eşlenmedi";
  if (binding.status === "active") return "Eşlendi ve aktif";
  if (binding.status === "warning") return "Kontrol gerekli";
  if (binding.status === "disabled") return "Eşleme devre dışı";
  return "Eşleme kaydedildi";
}

export function ChannelBitrixBindingDrawer({
  channel,
  overview,
  onClose,
  onChanged,
}: {
  channel: ChannelForBitrixSettings;
  overview: BitrixBindingsOverview;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const overviewItem = overview.bindings.find(
    (item) => item.channelId === channel.id,
  );
  const existingBinding = overviewItem?.binding ?? null;
  const [connectionId, setConnectionId] = useState(
    existingBinding?.integrationConnectionId ??
      overview.connections[0]?.id ??
      "",
  );
  const [state, setState] = useState<OpenChannelsState | null>(null);
  const [lines, setLines] = useState<OpenLine[]>([]);
  const [pipelines, setPipelines] = useState<PipelineRow[]>([]);
  const [mode, setMode] = useState<"crm_context" | "open_channels" | "both">(
    "both",
  );
  const [settings, setSettings] =
    useState<OpenChannelsSettings>(defaultSettings);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bindingChoice, setBindingChoice] = useState<BindingChoice>(
    existingBinding ? "existing" : "none",
  );

  const mappingChanged = Boolean(
    existingBinding &&
    (existingBinding.integrationConnectionId !== connectionId ||
      existingBinding.lineId !== (settings.lineId ?? "")),
  );
  const usedLineOwners = useMemo(() => {
    const owners = new Map<string, string>();
    for (const item of overview.bindings) {
      if (
        item.channelId !== channel.id &&
        item.binding?.integrationConnectionId === connectionId
      )
        owners.set(item.binding.lineId, item.channelId);
    }
    return owners;
  }, [channel.id, connectionId, overview.bindings]);

  const loadConnection = useCallback(async () => {
    if (!connectionId) {
      setState(null);
      setLines([]);
      setPipelines([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [stateResult, lineResult, pipelineResult] = await Promise.all([
        apiJson<{ data: OpenChannelsState | null }>(
          `/api/v1/integrations/${connectionId}/open-channels`,
        ),
        apiJson<{ data: OpenLine[] }>(
          `/api/v1/integrations/${connectionId}/open-channels/lines`,
        ),
        apiJson<{ data: PipelineRow[] }>(
          `/api/v1/integrations/${connectionId}/pipelines`,
        ),
      ]);
      const remoteBinding = stateResult.data?.bindings?.find(
        (item) => item.brixchat_channel_id === channel.id,
      );
      const localBinding =
        existingBinding?.integrationConnectionId === connectionId
          ? existingBinding
          : null;
      const boundLineId = localBinding?.lineId ?? remoteBinding?.line_id ?? "";
      const nextSettings = {
        ...defaultSettings,
        ...(stateResult.data?.open_channels_settings ?? {}),
        ...(localBinding?.settings ?? {}),
        ...(remoteBinding?.settings ?? {}),
        brixchatChannelId: channel.id,
        ...(boundLineId ? { lineId: boundLineId } : {}),
      };
      setState(stateResult.data);
      setLines(lineResult.data);
      setPipelines(pipelineResult.data);
      setMode(stateResult.data?.bitrix_mode ?? "both");
      setSettings(nextSettings);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Bitrix24 kanal ayarları yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [channel.id, connectionId, existingBinding]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadConnection(), 0);
    return () => window.clearTimeout(timer);
  }, [loadConnection]);

  const pipelineOptions = useMemo(() => {
    const unique = new Map<string, string>();
    for (const row of pipelines)
      unique.set(row.pipeline_external_id, row.pipeline_name);
    return [...unique.entries()];
  }, [pipelines]);
  const stageOptions = pipelines.filter(
    (row) => row.pipeline_external_id === settings.pipelineId,
  );

  async function run(action: () => Promise<void>, successMessage: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await onChanged();
      await loadConnection();
      setNotice(successMessage);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "İşlem tamamlanamadı.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    if (!connectionId || mappingChanged) return;
    const { timelinePolicy: _timelinePolicy, ...settingsForSubmit } =
      settings;
    await run(
      () =>
        apiJson(`/api/v1/integrations/${connectionId}/open-channels`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode,
            ...settingsForSubmit,
            brixchatChannelId: channel.id,
            incomingEnabled: settings.incomingEnabled ?? true,
            outgoingEnabled: settings.outgoingEnabled ?? true,
            deliveryStatusSync: settings.deliveryStatusSync ?? true,
            sessionCloseSync: settings.sessionCloseSync ?? true,
          }),
        }),
      "Kanalın Bitrix24 eşleme ayarları kaydedildi.",
    );
  }

  async function ensureSeparateLine() {
    if (!connectionId) return;
    if (
      !window.confirm(
        "Bitrix24 içinde bu WhatsApp hattına özel yeni bir Open Channel oluşturulacak ve bağlanacak. Devam edilsin mi?",
      )
    )
      return;
    await run(
      () =>
        apiJson(`/api/v1/integrations/${connectionId}/open-channels/ensure`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channelId: channel.id,
            confirm: "CREATE_NEW",
          }),
        }),
      "Bu WhatsApp hattı için ayrı Open Channel oluşturuldu ve etkinleştirildi.",
    );
  }

  async function registerConnector() {
    if (!connectionId) return;
    await run(
      () =>
        apiJson(`/api/v1/integrations/${connectionId}/open-channels/register`, {
          method: "POST",
        }),
      "Bitrix24 connector kaydedildi.",
    );
  }

  async function activate() {
    if (!connectionId || !settings.lineId) return;
    if (
      !window.confirm(
        mappingChanged
          ? "Bu WhatsApp hattı seçili Bitrix24 portalı ve Open Channel'a taşınacak. Eski oturum eşlemeleri kapatılacak, mesaj ve CRM geçmişi korunacak. Devam edilsin mi?"
          : "Seçili Open Channel bu WhatsApp hattı için etkinleştirilecek. Devam edilsin mi?",
      )
    )
      return;
    await run(
      async () => {
        // timelinePolicy isn't user-editable in this form: it's implied by
        // `mode`. Omit whatever stale value was loaded from an existing
        // binding so the backend recomputes it from the selected mode
        // instead of silently carrying over a value from a previous save.
        const { timelinePolicy: _timelinePolicy, ...settingsForSubmit } =
          settings;
        if (mappingChanged) {
          await apiJson(
            `/api/v1/integrations/${connectionId}/open-channels/remap`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                confirm: "REMAP",
                mode,
                ...settingsForSubmit,
                brixchatChannelId: channel.id,
              }),
            },
          );
          return;
        }
        await apiJson(`/api/v1/integrations/${connectionId}/open-channels`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode,
            ...settingsForSubmit,
            brixchatChannelId: channel.id,
          }),
        });
        await apiJson(
          `/api/v1/integrations/${connectionId}/open-channels/activate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              confirm: "ACTIVATE",
              channelId: channel.id,
            }),
          },
        );
      },
      mappingChanged
        ? "WhatsApp hattı yeni Bitrix24 Open Channel'a taşındı; geçmiş veriler korundu."
        : "Bitrix24 Open Channel eşlemesi aktif.",
    );
  }

  async function health() {
    const bindingConnectionId = existingBinding?.integrationConnectionId;
    if (!bindingConnectionId) return;
    await run(
      () =>
        apiJson(
          `/api/v1/integrations/${bindingConnectionId}/open-channels/health`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channelId: channel.id }),
          },
        ),
      "Bitrix24 bağlantı sağlık kontrolü tamamlandı.",
    );
  }

  async function deactivate() {
    if (!existingBinding) return;
    if (
      !window.confirm(
        "Eşleme devre dışı bırakılacak. Geçmiş konuşmalar ve CRM kayıtları korunacak. Devam edilsin mi?",
      )
    )
      return;
    await run(
      () =>
        apiJson(
          `/api/v1/integrations/${existingBinding.integrationConnectionId}/open-channels/deactivate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              confirm: "DEACTIVATE",
              channelId: channel.id,
            }),
          },
        ),
      "Eşleme devre dışı bırakıldı; geçmiş veriler korundu.",
    );
  }

  return (
    <div
      className="oc-drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose();
      }}
    >
      <aside
        className="oc-drawer channel-binding-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-binding-drawer-title"
      >
        <header className="oc-drawer-header">
          <div>
            <span>WhatsApp kanal ayarları</span>
            <h2 id="channel-binding-drawer-title">{channel.name}</h2>
            <p>
              {channel.phoneNumber ?? "Numara bekleniyor"} ·{" "}
              {providerLabel(channel.provider)}
            </p>
          </div>
          <button
            type="button"
            aria-label="Kanal ayarlarını kapat"
            disabled={busy}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div className="oc-drawer-body">
          <section className="oc-drawer-summary channel-binding-summary">
            <span
              className={`channel-binding-status ${
                existingBinding?.status ?? "unmapped"
              }`}
            >
              <MessageCircle size={15} />
              {bindingStatusLabel(existingBinding)}
            </span>
            <span>
              {existingBinding
                ? `Line ID: ${existingBinding.lineId}`
                : "Her WhatsApp hattı ayrı bir Bitrix Open Channel'a bağlanır."}
            </span>
          </section>

          {overview.connections.length === 0 ? (
            <div className="oc-feedback error" role="alert">
              <CircleAlert size={17} />
              Önce bağlı bir Bitrix24 entegrasyonu oluşturun.
            </div>
          ) : (
            <>
              <section className="oc-form-section">
                <header>
                  <span>
                    <Columns3 size={17} />
                  </span>
                  <div>
                    <h3>Bitrix24 eşlemesi</h3>
                    <p>
                      Bu WhatsApp hattının mesajlarını alacak portalı ve Open
                      Channel&apos;ı seçin.
                    </p>
                  </div>
                </header>
                <div className="oc-form-grid">
                  <label className="full">
                    Bitrix24 bağlantısı
                    <select
                      value={connectionId}
                      disabled={busy}
                      onChange={(event) => {
                        setConnectionId(event.target.value);
                        setSettings(defaultSettings);
                        setBindingChoice(existingBinding ? "existing" : "none");
                      }}
                    >
                      {overview.connections.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                          {item.portalUrl ? ` · ${item.portalUrl}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Çalışma modu
                    <select
                      value={mode}
                      disabled={loading || busy}
                      onChange={(event) =>
                        setMode(
                          event.target.value as
                            "crm_context" | "open_channels" | "both",
                        )
                      }
                    >
                      <option value="open_channels">
                        Yalnız Open Channels
                      </option>
                      <option value="both">CRM + Open Channels</option>
                      <option value="crm_context">Yalnız CRM context</option>
                    </select>
                  </label>
                  {!existingBinding && (
                    <fieldset className="full oc-binding-choice">
                      <legend>Bitrix24 Open Channel tercihi</legend>
                      <label>
                        <input
                          type="radio"
                          name="bitrixBindingChoice"
                          checked={bindingChoice === "none"}
                          disabled={busy}
                          onChange={() => {
                            setBindingChoice("none");
                            setSettings((current) => ({
                              ...current,
                              lineId: "",
                            }));
                          }}
                        />
                        Şimdilik Bitrix24 kanalına bağlama
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="bitrixBindingChoice"
                          checked={bindingChoice === "existing"}
                          disabled={busy}
                          onChange={() => setBindingChoice("existing")}
                        />
                        Var olan Open Channel&apos;ı seç
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="bitrixBindingChoice"
                          checked={bindingChoice === "new"}
                          disabled={busy}
                          onChange={() => {
                            setBindingChoice("new");
                            setSettings((current) => ({
                              ...current,
                              lineId: "",
                            }));
                          }}
                        />
                        Yeni Open Channel oluştur
                      </label>
                    </fieldset>
                  )}
                  {(existingBinding || bindingChoice === "existing") && (
                    <label>
                      Bitrix24 Open Channel
                      <select
                        value={settings.lineId ?? ""}
                        disabled={loading || busy}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            lineId: event.target.value,
                          }))
                        }
                      >
                        <option value="">Open Channel seçin</option>
                        {lines.map((line) => {
                          const usedBy = usedLineOwners.get(line.id);
                          return (
                            <option
                              key={line.id}
                              value={line.id}
                              disabled={!line.active || Boolean(usedBy)}
                            >
                              {line.name} · Line {line.id}
                              {!line.active
                                ? " (pasif)"
                                : usedBy
                                  ? " (başka hatta bağlı)"
                                  : ""}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  )}
                </div>
                {existingBinding && (
                  <div className="oc-safety-note">
                    <Link2 size={16} />
                    <span>
                      Portal veya Open Channel daha sonra değiştirilebilir.
                      Taşıma sırasında eski oturum eşlemeleri kapatılır; mesaj,
                      kişi ve CRM geçmişi silinmez.
                    </span>
                  </div>
                )}
              </section>

              <section className="oc-form-section">
                <header>
                  <span>
                    <ShieldCheck size={17} />
                  </span>
                  <div>
                    <h3>CRM kayıt kuralı</h3>
                    <p>
                      Bilinmeyen WhatsApp numaralarının CRM&apos;de nasıl
                      işleneceğini belirleyin.
                    </p>
                  </div>
                </header>
                <div className="oc-form-grid">
                  <label className="full">
                    Bilinmeyen numarada oluştur
                    <select
                      value={settings.autoCrmMode ?? "disabled"}
                      disabled={loading || busy}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          autoCrmMode: event.target.value as
                            "disabled" | "lead" | "contact_and_deal",
                        }))
                      }
                    >
                      <option value="disabled">Otomatik kayıt yok</option>
                      <option value="lead">Lead</option>
                      <option value="contact_and_deal">Kişi + Fırsat</option>
                    </select>
                  </label>
                  {settings.autoCrmMode === "contact_and_deal" && (
                    <>
                      <label>
                        Pipeline
                        <select
                          value={settings.pipelineId ?? ""}
                          onChange={(event) => {
                            const pipelineId = event.target.value;
                            const firstStage = pipelines.find(
                              (row) => row.pipeline_external_id === pipelineId,
                            );
                            setSettings((current) => ({
                              ...current,
                              pipelineId,
                              stageId: firstStage?.stage_external_id ?? "",
                            }));
                          }}
                        >
                          <option value="">Pipeline seçin</option>
                          {pipelineOptions.map(([id, name]) => (
                            <option key={id} value={id}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        İlk aşama
                        <select
                          value={settings.stageId ?? ""}
                          onChange={(event) =>
                            setSettings((current) => ({
                              ...current,
                              stageId: event.target.value,
                            }))
                          }
                        >
                          <option value="">Aşama seçin</option>
                          {stageOptions.map((stage) => (
                            <option
                              key={stage.stage_external_id}
                              value={stage.stage_external_id}
                            >
                              {stage.stage_name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>
              </section>

              <section className="oc-form-section">
                <header>
                  <span>
                    <ArrowLeftRight size={17} />
                  </span>
                  <div>
                    <h3>Mesaj akışı</h3>
                    <p>İki yönlü mesaj ve durum senkronizasyonunu yönetin.</p>
                  </div>
                </header>
                <div className="oc-toggle-grid">
                  {flowToggles.map((toggle) => (
                    <label key={toggle.key}>
                      <span>
                        <strong>{toggle.label}</strong>
                        <small>{toggle.hint}</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={Boolean(settings[toggle.key])}
                        disabled={loading || busy}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            [toggle.key]: event.target.checked,
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </section>
            </>
          )}

          {notice && (
            <div className="oc-feedback success" role="status">
              <Check size={17} /> {notice}
            </div>
          )}
          {error && (
            <div className="oc-feedback error" role="alert">
              <CircleAlert size={17} /> {error}
            </div>
          )}
        </div>

        <footer className="oc-drawer-footer">
          <div className="oc-lifecycle-actions">
            <button
              type="button"
              disabled={busy || !connectionId}
              onClick={() => void registerConnector()}
            >
              Connector kaydet
            </button>
            <button
              type="button"
              disabled={busy || !existingBinding}
              onClick={() => void health()}
            >
              <HeartPulse size={15} /> Sağlık testi
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || !existingBinding}
              onClick={() => void deactivate()}
            >
              <Unplug size={15} /> Devre dışı bırak
            </button>
          </div>
          <div className="oc-save-actions">
            {!existingBinding && bindingChoice === "new" && (
              <button
                type="button"
                className="oc-secondary-button"
                disabled={busy || !connectionId || !state?.connector_id}
                onClick={() => void ensureSeparateLine()}
              >
                Yeni Open Channel oluştur ve bağla
              </button>
            )}
            <button
              type="button"
              className="oc-secondary-button"
              disabled={busy}
              onClick={onClose}
            >
              Kapat
            </button>
            <button
              type="button"
              className="oc-secondary-button"
              disabled={
                busy ||
                !connectionId ||
                (!existingBinding && bindingChoice !== "existing") ||
                mappingChanged ||
                (mode !== "crm_context" && !settings.lineId)
              }
              onClick={() => void saveSettings()}
            >
              {mappingChanged
                ? "Değişiklik için etkinleştirin"
                : "Ayarları kaydet"}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                !connectionId ||
                (!existingBinding && bindingChoice !== "existing") ||
                !settings.lineId
              }
              onClick={() => void activate()}
            >
              {busy ? "İşleniyor…" : "Kaydet ve etkinleştir"}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
