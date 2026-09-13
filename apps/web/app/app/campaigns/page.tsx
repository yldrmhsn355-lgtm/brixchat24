"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppFrame } from "../../../components/app-frame";
import { apiJson } from "../../../lib/api";
import type { CampaignCsvPreview } from "@brixchat/shared";
import styles from "./page.module.css";

type Channel = {
  id: string;
  name: string;
  phone_number: string | null;
  provider: string;
};
type Template = {
  id: string;
  channel_id: string;
  name: string;
  language: string;
  body_text: string;
  variables: Array<{
    key: string;
    required: boolean;
    defaultValue: string | null;
  }>;
};
type Content =
  | { type: "text"; text: string }
  | { type: "template"; templateId: string; variables: Record<string, string> };
type Campaign = {
  id: string;
  name: string;
  channel_id: string;
  status: string;
  content: Content;
};
type Recipient = {
  id: string;
  phone: string;
  name: string;
  status: string;
  error_code: string | null;
};
type History = Campaign & {
  recipient_count: number;
  pending_count: number;
  sent_count: number;
  failed_count: number;
  canceled_count: number;
};
type DryRun = {
  token: string;
  recipientCount: number;
  eligibleCount: number;
  blockedCount: number;
  blockers: string[];
  messagePreview: string;
  recipients: Array<{
    id: string;
    phone: string;
    name: string;
    reason: string | null;
  }>;
};
const states: Record<string, string> = {
  draft: "Taslak",
  queued: "Kuyrukta",
  processing: "İşleniyor",
  completed: "Tamamlandı",
  canceled: "İptal",
  pending: "Bekliyor",
  sent: "Gönderildi",
  failed: "Başarısız",
};
const reasons: Record<string, string> = {
  whatsapp_opt_in_missing: "WhatsApp iletişim izni kayıtlı değil.",
  WHATSAPP_TEMPLATE_REQUIRED: "Mesajlaşma süresi kapalı; onaylı şablon seçin.",
  campaign_connected_channel_required: "Bağlı bir WhatsApp hattı seçin.",
  campaign_approved_template_required: "Bu hat için onaylı şablon bulunamadı.",
  campaign_template_variables_missing: "Şablon değişkenlerini doldurun.",
  campaign_template_media_required:
    "Bu şablon medya başlığı gerektiriyor; metin şablonu seçin.",
  campaign_quota_insufficient:
    "Kalan mesaj kotası alıcı sayısı için yeterli değil.",
  campaign_dry_run_expired: "Deneme süresi doldu. Dry-run işlemini yenileyin.",
  campaign_dry_run_blocked:
    "Uygunluk hatalarını giderip dry-run işlemini yenileyin.",
  campaign_manager_required:
    "Kampanyaları firma sahibi veya yönetici yönetebilir.",
  campaign_confirmation_mismatch:
    "Alıcı sayısı değişti. Ön izlemeyi yenileyin.",
  campaign_preview_changed:
    "Şablon ön izlemeden sonra değişti; yeni taslak oluşturun.",
  CAMPAIGN_DELIVERY_UNCERTAIN:
    "Gönderim sonucu doğrulanamadı. Yeniden göndermeden önce WhatsApp üzerinden kontrol edin.",
  CAMPAIGN_DELIVERY_BLOCKED_OR_UNCERTAIN:
    "Gönderim engellendi veya önceki denemenin sonucu belirsiz. Tekrar göndermeden önce kontrol edin.",
  organization_disabled: "Firma hesabı işlem yapmaya kapalı.",
  trial_expired: "Deneme süresi dolmuş.",
  plan_limit_exceeded: "Mesaj kotası dolmuş.",
};
const explain = (code: string) => reasons[code] ?? code;
const post = <T,>(path: string, body: unknown = {}) =>
  apiJson<{ data: T }>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export default function CampaignsPage() {
  const [options, setOptions] = useState<{
    channels: Channel[];
    templates: Template[];
  }>({ channels: [], templates: [] });
  const [history, setHistory] = useState<History[]>([]);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [name, setName] = useState(""),
    [channelId, setChannelId] = useState(""),
    [kind, setKind] = useState<"text" | "template">("text");
  const [text, setText] = useState(""),
    [templateId, setTemplateId] = useState(""),
    [variables, setVariables] = useState<Record<string, string>>({});
  const [csv, setCsv] = useState<CampaignCsvPreview | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const [campaign, setCampaign] = useState<Campaign | null>(null),
    [recipients, setRecipients] = useState<Recipient[]>([]);
  const [dryRun, setDryRun] = useState<DryRun | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const request = useRef<{ fingerprint: string; key: string } | null>(null);
  const selectedTemplate = options.templates.find(
    (item) => item.id === templateId && item.channel_id === channelId,
  );
  const refresh = useCallback(async () => {
    const [settings, list] = await Promise.all([
      apiJson<{ data: typeof options }>("/api/v1/campaigns/options"),
      apiJson<{ data: History[] }>("/api/v1/campaigns"),
    ]);
    setOptions(settings.data);
    setHistory(list.data);
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([
      apiJson<{ data: typeof options }>("/api/v1/campaigns/options"),
      apiJson<{ data: History[] }>("/api/v1/campaigns"),
    ])
      .then(([settings, list]) => {
        if (active) {
          setOptions(settings.data);
          setHistory(list.data);
        }
      })
      .catch((e: Error) => {
        if (active) setError(explain(e.message));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!campaign || !["queued", "processing"].includes(campaign.status))
      return;
    let active = true;
    const timer = window.setInterval(() => {
      void apiJson<{ data: { campaign: Campaign; recipients: Recipient[] } }>(
        `/api/v1/campaigns/${campaign.id}`,
      )
        .then(({ data }) => {
          if (active) {
            setCampaign(data.campaign);
            setRecipients(data.recipients);
            void refresh().catch(() => {});
          }
        })
        .catch((e: Error) => {
          if (active) setError(explain(e.message));
        });
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [campaign, refresh]);
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(
        explain(e instanceof Error ? e.message : "İşlem tamamlanamadı."),
      );
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setCampaign(null);
    setRecipients([]);
    setDryRun(null);
    setConfirmed(false);
    setCsv(null);
    setSelected(new Set());
    setName("");
    setText("");
    setTemplateId("");
    setVariables({});
    request.current = null;
    setError("");
  }
  async function open(id: string) {
    const { data } = await apiJson<{
      data: { campaign: Campaign; recipients: Recipient[] };
    }>(`/api/v1/campaigns/${id}`);
    setCampaign(data.campaign);
    setRecipients(data.recipients);
    setName(data.campaign.name);
    setChannelId(data.campaign.channel_id);
    setKind(data.campaign.content.type);
    setText(
      data.campaign.content.type === "text" ? data.campaign.content.text : "",
    );
    setTemplateId(
      data.campaign.content.type === "template"
        ? data.campaign.content.templateId
        : "",
    );
    setVariables(
      data.campaign.content.type === "template"
        ? data.campaign.content.variables
        : {},
    );
    setDryRun(null);
    setConfirmed(false);
  }
  async function create() {
    const payload = {
      name,
      channelId,
      content:
        kind === "text"
          ? { type: "text", text }
          : { type: "template", templateId, variables },
      recipients:
        csv?.recipients.filter((item) => selected.has(item.phone)) ?? [],
    };
    const fingerprint = JSON.stringify(payload);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, key: crypto.randomUUID() };
    const { data } = await post<Campaign>("/api/v1/campaigns", {
      ...payload,
      requestKey: request.current.key,
    });
    await open(data.id);
    await refresh();
  }
  const ready =
    dryRun &&
    !dryRun.blockers.length &&
    !dryRun.blockedCount &&
    dryRun.eligibleCount > 0;
  return (
    <AppFrame
      title="Kampanyalar"
      subtitle="Alıcıları seçin, mesajı kontrol edin ve gönderimden önce deneme yapın."
      actions={
        <button className="secondary-button" disabled={busy} onClick={reset}>
          Yeni kampanya
        </button>
      }
    >
      {error && (
        <div role="alert" className="form-error">
          {error}
        </div>
      )}
      {loading ? (
        <p role="status">Kampanyalar yükleniyor…</p>
      ) : (
        <>
          {!options.channels.length && (
            <div className={styles.notice}>
              Henüz bağlı WhatsApp hattı yok.{" "}
              <Link href="/app/integrations">
                Entegrasyonlardan bir hat bağlayın.
              </Link>
            </div>
          )}
          <div className={styles.grid}>
            <section className={styles.card} aria-label="Kampanya hazırlama">
              <div className={styles.heading}>
                <h2>{campaign ? campaign.name : "1. Kampanyayı hazırlayın"}</h2>
                {campaign && (
                  <span className={styles.badge}>
                    {states[campaign.status] ?? campaign.status}
                  </span>
                )}
              </div>
              <fieldset
                disabled={busy || Boolean(campaign)}
                className={styles.fields}
              >
                <label>
                  Kampanya adı
                  <input
                    value={name}
                    maxLength={120}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Örneğin: Eylül müşteri bilgilendirmesi"
                  />
                </label>
                <label>
                  Gönderici WhatsApp hattı
                  <select
                    value={channelId}
                    onChange={(e) => {
                      setChannelId(e.target.value);
                      setTemplateId("");
                      setVariables({});
                    }}
                  >
                    <option value="">Hat seçin</option>
                    {options.channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name} · {channel.phone_number ?? ""} ·{" "}
                        {channel.provider === "meta" ? "Meta" : "WhatsApp Web"}
                      </option>
                    ))}
                    {campaign &&
                      !options.channels.some(
                        (item) => item.id === channelId,
                      ) && (
                        <option value={channelId}>Bağlantısı kapalı hat</option>
                      )}
                  </select>
                </label>
                <label>
                  Mesaj türü
                  <select
                    value={kind}
                    onChange={(e) =>
                      setKind(e.target.value as "text" | "template")
                    }
                  >
                    <option value="text">Metin mesajı</option>
                    <option value="template">Onaylı şablon</option>
                  </select>
                </label>
                {kind === "text" ? (
                  <label>
                    Mesaj
                <textarea
                  aria-label="Mesaj"
                      rows={5}
                      maxLength={4096}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="Alıcılara gönderilecek mesaj"
                    />
                    <small>
                      Mesajlaşma süresi açık alıcılara gönderilir. Süre
                      dışındaki alıcılar için onaylı şablon kullanın.
                    </small>
                  </label>
                ) : (
                  <>
                    <label>
                      Şablon
                      <select
                        value={templateId}
                        onChange={(e) => {
                          setTemplateId(e.target.value);
                          setVariables({});
                        }}
                      >
                        <option value="">Şablon seçin</option>
                        {options.templates
                          .filter((item) => item.channel_id === channelId)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · {item.language}
                            </option>
                          ))}
                      </select>
                    </label>
                    {selectedTemplate?.variables.map((variable) => (
                      <label key={variable.key}>
                        {variable.key}
                        {variable.required ? " (zorunlu)" : ""}
                        <input
                          value={variables[variable.key] ?? ""}
                          maxLength={1024}
                          placeholder={variable.defaultValue ?? "Değer"}
                          onChange={(e) =>
                            setVariables({
                              ...variables,
                              [variable.key]: e.target.value,
                            })
                          }
                        />
                      </label>
                    ))}
                    {selectedTemplate && (
                      <pre className={styles.preview}>
                        {selectedTemplate.body_text}
                      </pre>
                    )}
                  </>
                )}
              </fieldset>
              {!campaign && (
                <>
                  <h3>2. Alıcıları içe aktarın</h3>
                  <p className={styles.muted}>
                    UTF-8 CSV: <code>telefon,isim</code> başlıkları. Telefonlar
                    +90 gibi ülke koduyla başlamalıdır. En fazla 1000 alıcı.
                  </p>
                  <label className={styles.upload}>
                    CSV dosyası
                    <input
                      aria-label="Alıcı CSV dosyası"
                      type="file"
                      accept=".csv,text/csv"
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        void act(async () => {
                          setCsv(null);
                          setSelected(new Set());
                          if (file.size > 1_000_000)
                            throw new Error(
                              "CSV dosyası en fazla 1 MB olabilir.",
                            );
                          const { data } = await post<CampaignCsvPreview>(
                            "/api/v1/campaigns/preview-csv",
                            { csv: await file.text() },
                          );
                          setCsv(data);
                          setSelected(
                            new Set(data.recipients.map((row) => row.phone)),
                          );
                        });
                      }}
                    />
                  </label>
                  {csv && (
                    <>
                      <p role="status">
                        {csv.recipients.length} geçerli alıcı · {csv.duplicates}{" "}
                        tekrar ayıklandı · {csv.errors.length} hatalı satır
                      </p>
                      {csv.errors.length > 0 && (
                        <details>
                          <summary>
                            Hatalı satırları göster (listeye alınmadı)
                          </summary>
                          <ul>
                            {csv.errors.map((row) => (
                              <li key={row.row}>
                                Satır {row.row}: {row.message}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={
                            csv.recipients.length > 0 &&
                            selected.size === csv.recipients.length
                          }
                          onChange={(e) =>
                            setSelected(
                              new Set(
                                e.target.checked
                                  ? csv.recipients.map((item) => item.phone)
                                  : [],
                              ),
                            )
                          }
                        />{" "}
                        Tüm geçerli alıcıları seç ({selected.size})
                      </label>
                      <div className={styles.recipientList}>
                        {csv.recipients.map((row) => (
                          <label className={styles.check} key={row.phone}>
                            <input
                              type="checkbox"
                              disabled={busy}
                              checked={selected.has(row.phone)}
                              onChange={(e) =>
                                setSelected((old) => {
                                  const next = new Set(old);
                                  if (e.target.checked) next.add(row.phone);
                                  else next.delete(row.phone);
                                  return next;
                                })
                              }
                            />
                            <span>
                              {row.name || "İsimsiz"}
                              <small>{row.phone}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                  <button
                    className="primary-button"
                    disabled={
                      busy ||
                      !name.trim() ||
                      !channelId ||
                      !selected.size ||
                      (kind === "text" ? !text.trim() : !templateId)
                    }
                    onClick={() => void act(create)}
                  >
                    Taslağı oluştur · {selected.size} alıcı
                  </button>
                </>
              )}
              {campaign && (
                <p className={styles.muted}>
                  Taslağın hat, mesaj ve alıcıları sabittir. Değişiklik için
                  yeni kampanya oluşturun.
                </p>
              )}
            </section>
            <section
              className={styles.card}
              aria-label="Gönderim öncesi kontrol"
            >
              <h2>3. Ön izleme ve dry-run</h2>
              {!campaign ? (
                <p className={styles.muted}>
                  Taslak oluşturduktan sonra alıcı uygunluğu burada görünecek.
                  Taslak ve dry-run mesaj göndermez.
                </p>
              ) : (
                <>
                  <p>
                    <strong>{recipients.length} alıcı</strong> ·{" "}
                    {options.channels.find(
                      (item) => item.id === campaign.channel_id,
                    )?.name ?? "Seçili hat"}
                  </p>
                  <pre className={styles.preview}>
                    {dryRun?.messagePreview ??
                      (campaign.content.type === "text"
                        ? campaign.content.text
                        : (selectedTemplate?.body_text ??
                          "Şablon ön izlemesi için dry-run çalıştırın."))}
                  </pre>
                  {campaign.status === "draft" && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          setConfirmed(false);
                          setDryRun(null);
                          const { data } = await post<DryRun>(
                            `/api/v1/campaigns/${campaign.id}/dry-run`,
                          );
                          setDryRun(data);
                        })
                      }
                    >
                      Mesaj göndermeden dene (dry-run)
                    </button>
                  )}
                  {dryRun && (
                    <>
                      <div className={styles.notice} role="status">
                        {dryRun.eligibleCount} uygun · {dryRun.blockedCount}{" "}
                        engelli alıcı.{" "}
                        {ready
                          ? "Kontrol başarılı. Onay 10 dakika geçerlidir."
                          : "Gönderim öncesi aşağıdaki hataları giderin."}
                      </div>
                      {dryRun.blockers.map((code) => (
                        <p key={code} className="form-error">
                          {explain(code)}
                        </p>
                      ))}
                      <div className={styles.recipientList}>
                        {dryRun.recipients
                          .filter((row) => row.reason)
                          .map((row) => (
                            <p key={row.id}>
                              <strong>{row.name || row.phone}</strong>
                              <br />
                              {explain(row.reason!)}
                            </p>
                          ))}
                      </div>
                    </>
                  )}
                  {campaign.status === "draft" && ready && (
                    <div className={styles.confirm}>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={confirmed}
                          disabled={busy}
                          onChange={(e) => setConfirmed(e.target.checked)}
                        />
                        {dryRun.recipientCount} alıcıya yukarıdaki mesajın
                        seçili WhatsApp hattından gönderilmesini onaylıyorum.
                      </label>
                      <button
                        className="primary-button"
                        disabled={busy || !confirmed}
                        onClick={() =>
                          void act(async () => {
                            await post(
                              `/api/v1/campaigns/${campaign.id}/start`,
                              {
                                confirm: true,
                                token: dryRun.token,
                                recipientCount: dryRun.recipientCount,
                              },
                            );
                            setConfirmed(false);
                            await open(campaign.id);
                            await refresh();
                          })
                        }
                      >
                        Gerçek gönderimi başlat
                      </button>
                    </div>
                  )}
                  {["draft", "queued", "processing"].includes(
                    campaign.status,
                  ) && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await post(`/api/v1/campaigns/${campaign.id}/cancel`);
                          await open(campaign.id);
                          await refresh();
                        })
                      }
                    >
                      Kampanyayı iptal et
                    </button>
                  )}
                  <p className={styles.muted}>
                    İptal, henüz gönderime başlanmamış alıcıları durdurur.
                    Gönderilmiş mesaj geri alınamaz. Sonucu belirsiz gönderimler
                    otomatik tekrarlanmaz.
                  </p>
                  <div className={styles.scroll}>
                    <table>
                      <caption>Alıcı durumları</caption>
                      <thead>
                        <tr>
                          <th>Alıcı</th>
                          <th>Durum</th>
                          <th>Açıklama</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recipients.map((row) => (
                          <tr key={row.id}>
                            <td>
                              {row.name || row.phone}
                              <small>{row.name ? row.phone : ""}</small>
                            </td>
                            <td>{states[row.status] ?? row.status}</td>
                            <td>
                              {row.error_code ? explain(row.error_code) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </div>
          <section className={styles.card}>
            <div className={styles.heading}>
              <h2>Kampanya geçmişi</h2>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void act(refresh)}
              >
                Yenile
              </button>
            </div>
            {!history.length ? (
              <p className={styles.muted}>Henüz kampanya oluşturulmadı.</p>
            ) : (
              <div className={styles.scroll}>
                <table>
                  <thead>
                    <tr>
                      <th>Kampanya</th>
                      <th>Durum</th>
                      <th>Alıcı</th>
                      <th>Bekleyen</th>
                      <th>Gönderilen</th>
                      <th>Başarısız</th>
                      <th>İptal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <button
                            className={styles.link}
                            disabled={busy}
                            onClick={() => void act(() => open(item.id))}
                          >
                            {item.name}
                          </button>
                        </td>
                        <td>{states[item.status] ?? item.status}</td>
                        <td>{item.recipient_count}</td>
                        <td>{item.pending_count}</td>
                        <td>{item.sent_count}</td>
                        <td>{item.failed_count}</td>
                        <td>{item.canceled_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </AppFrame>
  );
}
