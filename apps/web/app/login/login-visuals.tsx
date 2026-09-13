import {
  Activity,
  MessageCircleMore,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";

const preview = {
  total: "9.842",
  change: "24,6%",
  online: 32,
  waiting: 128,
  responseRate: "%94",
  days: ["10 May", "11 May", "12 May", "13 May", "14 May", "15 May", "16 May"],
} as const;

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "login-brand compact" : "login-brand"}>
      <span className="login-brand-mark" aria-hidden="true">
        <MessageCircleMore />
      </span>
      <strong>Brixchat24</strong>
    </div>
  );
}

function FeatureBadges() {
  return (
    <div className="login-feature-badges" aria-label="Platform özellikleri">
      <span className="feature-badge whatsapp">
        <MessageCircleMore aria-hidden="true" /> WhatsApp Cloud API
      </span>
      <span className="feature-badge realtime">
        <Zap aria-hidden="true" /> Gerçek zamanlı
      </span>
      <span className="feature-badge secure">
        <ShieldCheck aria-hidden="true" /> 256-bit güvenlik
      </span>
    </div>
  );
}

function ConnectionArtwork() {
  return (
    <div className="connection-artwork" aria-hidden="true">
      <svg viewBox="0 0 480 520" preserveAspectRatio="none">
        <path d="M12 420 C125 420 80 220 228 220 S335 118 428 118" />
        <path d="M40 470 C160 470 120 300 268 300 S355 190 460 190" />
        <path d="M82 510 C195 510 160 370 310 370 S390 250 470 250" />
        <path d="M0 360 C105 360 110 265 205 265 S300 58 430 58" />
      </svg>
      <span className="network-node node-message">
        <MessageSquareText />
      </span>
      <span className="network-node node-whatsapp">
        <MessageCircleMore />
      </span>
      <span className="network-node node-automation">
        <Sparkles />
      </span>
    </div>
  );
}

function ActivityPreview() {
  return (
    <section className="activity-preview" aria-hidden="true">
      <header>
        <div>
          <strong>Konuşma Aktivitesi</strong>
          <span>
            <i /> Gerçek zamanlı
          </span>
        </div>
        <span className="activity-period">Son 7 gün⌄</span>
      </header>
      <div className="activity-main">
        <div className="activity-total">
          <strong>{preview.total}</strong>
          <span>Toplam konuşma</span>
          <em>↑ {preview.change}</em>
          <small>önceki 7 güne göre</small>
        </div>
        <div className="activity-chart">
          <div className="chart-scale">
            <span>12K</span>
            <span>8K</span>
            <span>4K</span>
            <span>0</span>
          </div>
          <svg
            viewBox="0 0 420 150"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#7656ff" stopOpacity=".48" />
                <stop offset="1" stopColor="#7656ff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              className="chart-area"
              d="M8 127 L55 98 L98 104 L143 80 L186 91 L230 65 L275 76 L318 54 L365 45 L412 24 L412 150 L8 150 Z"
            />
            <path
              className="chart-line"
              d="M8 127 L55 98 L98 104 L143 80 L186 91 L230 65 L275 76 L318 54 L365 45 L412 24"
            />
            <circle cx="412" cy="24" r="6" />
          </svg>
          <div className="chart-days">
            {preview.days.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
        </div>
      </div>
      <footer>
        <div className="active-team">
          <span>Aktif Ekip</span>
          <div className="avatar-stack" aria-hidden="true">
            <i className="avatar-one">AY</i>
            <i className="avatar-two">ÖÖ</i>
            <i className="avatar-three">HY</i>
            <i>+12</i>
          </div>
        </div>
        <dl>
          <div>
            <dt>
              <i /> Çevrimiçi
            </dt>
            <dd>{preview.online}</dd>
          </div>
          <div>
            <dt>Yanıt bekleyen</dt>
            <dd>{preview.waiting}</dd>
          </div>
          <div>
            <dt>Yanıt oranı</dt>
            <dd>{preview.responseRate}</dd>
          </div>
        </dl>
      </footer>
    </section>
  );
}

export function BrandPanel() {
  return (
    <section className="login-brand-panel">
      <div className="login-grid" aria-hidden="true" />
      <BrandMark />
      <div className="brand-content">
        <FeatureBadges />
        <h2>
          Tüm müşteri konuşmaları.
          <br />
          Tek akıllı çalışma alanı.
        </h2>
        <p>
          WhatsApp ekipleri için hızlı, güvenli ve ölçülebilir iletişim
          altyapısı.
        </p>
        <ActivityPreview />
      </div>
      <ConnectionArtwork />
      <div className="digital-horizon" aria-hidden="true" />
    </section>
  );
}

export function SecureConnection() {
  return (
    <p className="secure-connection">
      <ShieldCheck aria-hidden="true" /> Güvenli bağlantı
    </p>
  );
}
