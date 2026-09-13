import Link from "next/link";
import {
  ArrowUpRight,
  BookOpenText,
  CircleHelp,
  MessageCircleMore,
  Settings,
} from "lucide-react";
import { AppFrame } from "../../../components/app-frame";

export default function HelpPage() {
  return (
    <AppFrame
      title="Yardım Merkezi"
      subtitle="Sık kullanılan Brixchat24 akışlarına doğrudan ulaşın."
    >
      <div className="help-grid">
        <section className="stack-card">
          <MessageCircleMore size={22} aria-hidden="true" />
          <h2>Mesajlaşmaya başlayın</h2>
          <p>
            Gelen Kutusu’nda mevcut konuşmaları yönetin veya bağlı bir WhatsApp
            hesabından yeni müşteri konuşması hazırlayın.
          </p>
          <Link className="subtle-button" href="/app/inbox">
            Gelen Kutusuna git
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </section>
        <section className="stack-card">
          <BookOpenText size={22} aria-hidden="true" />
          <h2>24 saat dışı mesajlar</h2>
          <p>
            Müşterinin son mesajından 24 saat geçtiyse yalnızca Meta tarafından
            onaylanmış bir WhatsApp şablonu gönderebilirsiniz.
          </p>
          <Link className="subtle-button" href="/app/templates">
            Şablonları aç
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </section>
        <section className="stack-card">
          <Settings size={22} aria-hidden="true" />
          <h2>Bağlantıları kontrol edin</h2>
          <p>
            Mesaj ulaşmıyorsa önce kanal durumunu, ardından entegrasyon ve
            production sağlık kontrollerini inceleyin.
          </p>
          <div className="help-actions">
            <Link className="subtle-button" href="/app/channels">
              Kanallar
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
            <Link className="subtle-button" href="/app/settings/production">
              Production
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </section>
        <section className="stack-card">
          <CircleHelp size={22} aria-hidden="true" />
          <h2>Sorun bildirirken</h2>
          <p>
            Konuşma adı, yaklaşık saat, kullanılan kanal ve Production
            sayfasındaki sürüm bilgisini birlikte paylaşın. Parola veya erişim
            anahtarı göndermeyin.
          </p>
        </section>
      </div>
    </AppFrame>
  );
}
