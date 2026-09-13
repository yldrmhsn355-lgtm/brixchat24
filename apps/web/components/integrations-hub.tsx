"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Link2,
  Settings2,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { apiJson } from "../lib/api";

type Connection = {
  id: string;
  provider: string;
  name: string;
  portalUrl: string | null;
  status: string;
};

export function IntegrationsHub() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await apiJson<{ data: Connection[] }>(
        "/api/v1/integrations",
      );
      setConnections(result.data);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Entegrasyonlar yüklenemedi",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const bitrix = connections.find((item) => item.provider === "bitrix24");
  const connectedCount = connections.filter(
    (item) => item.status === "connected",
  ).length;

  return (
    <AppFrame
      title="Entegrasyonlar"
      subtitle="CRM ve iş uygulaması entegrasyonlarınızı tek merkezden yönetin."
      actions={
        <Link
          className="primary-button compact-button"
          href="/app/integrations/bitrix24/connect"
        >
          <Link2 size={16} />
          Entegrasyon ekle
        </Link>
      }
    >
      {error && <div className="form-error">{error}</div>}
      <section className="integration-summary" aria-label="Entegrasyon özeti">
        <div>
          <span className="eyebrow">Bağlantı merkezi</span>
          <h2>CRM entegrasyonlarınız</h2>
          <p>
            Kanal sağlayıcıları Kanallar modülünde; CRM bağlantıları burada
            ayar, senkron ve log ekranlarıyla yönetilir.
          </p>
        </div>
        <div className="integration-summary-stat">
          <strong>{loading ? "—" : connectedCount}</strong>
          <span>aktif bağlantı</span>
        </div>
      </section>

      <div className="integration-widget-grid">
        <article className="integration-widget integration-widget-featured">
          <div className="integration-widget-icon bitrix-icon">
            <Boxes size={26} />
          </div>
          <div className="integration-widget-body">
            <div className="integration-widget-heading">
              <div>
                <span className="eyebrow">CRM ve otomasyon</span>
                <h2>Bitrix24</h2>
              </div>
              <span
                className={`status-pill ${bitrix?.status === "connected" ? "healthy" : "warning"}`}
              >
                {bitrix?.status === "connected" ? "Bağlı" : "Kuruluma hazır"}
              </span>
            </div>
            <p>
              Konuşmaları CRM kayıtları, sorumlular, timeline ve Open Channels
              akışıyla eşleştirin.
            </p>
            {bitrix?.portalUrl && (
              <small className="integration-widget-portal">
                {bitrix.portalUrl}
              </small>
            )}
            <div className="integration-widget-actions">
              <Link
                className="primary-button compact-button"
                href="/app/integrations/bitrix24"
              >
                {bitrix ? "Bitrix24'ü yönet" : "Bitrix24'ü bağla"}{" "}
                <ArrowRight size={15} />
              </Link>
              {bitrix && (
                <Link
                  className="subtle-button"
                  href="/app/integrations/bitrix24/settings"
                >
                  <Settings2 size={15} /> Ayarlar
                </Link>
              )}
            </div>
          </div>
          <div className="integration-widget-footer">
            <CheckCircle2 size={15} /> OAuth, webhook, senkron ve audit log
            altyapısı hazır
          </div>
        </article>
      </div>
    </AppFrame>
  );
}
