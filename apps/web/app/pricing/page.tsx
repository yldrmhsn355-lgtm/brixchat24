import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing | Brixchat24",
  description: "Brixchat24 Bitrix24 Market pricing policy.",
};

export default function PricingPage() {
  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: "48px 24px 80px",
        fontFamily: "Arial, sans-serif",
        lineHeight: 1.65,
        color: "#172033",
      }}
    >
      <h1>Brixchat24 Pricing</h1>
      <h2>Bitrix24 Market version: Free</h2>
      <p>
        The Brixchat24 version offered through Bitrix24 Market has no Brixchat24
        application license or subscription fee.
      </p>
      <p>
        Third-party costs are not included. The Customer remains responsible for
        any WhatsApp Business Platform or Meta provider charges and for the
        Bitrix24 plan required to use CRM and Open Channels functionality.
      </p>
      <p>
        If optional paid services or a paid version are introduced in the
        future, they will require separate notice and acceptance and will not be
        activated automatically.
      </p>

      <h2>Türkçe fiyatlandırma</h2>
      <p>
        Bitrix24 Market üzerinden sunulan Brixchat24 sürümü ücretsizdir ve
        Brixchat24 uygulama lisansı veya abonelik ücreti içermez.
      </p>
      <p>
        WhatsApp Business Platform veya Meta sağlayıcı ücretleri ile CRM ve Açık
        Kanallar için gerekli Bitrix24 planının maliyeti müşteriye aittir.
      </p>
    </main>
  );
}
