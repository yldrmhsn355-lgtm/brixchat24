import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Support | Brixchat24",
  description: "Brixchat24 support channels, working hours and response target.",
};

export default function SupportPage() {
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
      <h1>Brixchat24 Support</h1>
      <p>
        Contact: {" "}
        <a href="mailto:hsnyldrm-590@hotmail.com">
          hsnyldrm-590@hotmail.com
        </a>
      </p>
      <ul>
        <li>Languages: English and Turkish</li>
        <li>
          Working hours: Monday–Friday, 09:00–18:00 Europe/Istanbul, excluding
          public holidays in Türkiye
        </li>
        <li>First-response target: within 1 business day</li>
      </ul>
      <p>
        Include your Bitrix24 portal address, Brixchat24 workspace name, the
        affected channel and a concise description of the issue. Do not send
        passwords, access tokens or WhatsApp credentials by email.
      </p>

      <h2>Türkçe destek</h2>
      <ul>
        <li>Destek dilleri: Türkçe ve İngilizce</li>
        <li>
          Çalışma saatleri: Pazartesi–Cuma, 09:00–18:00 Europe/Istanbul,
          Türkiye resmi tatilleri hariç
        </li>
        <li>İlk yanıt hedefi: 1 iş günü içinde</li>
      </ul>
      <p>
        Talebinizde Bitrix24 portal adresinizi, Brixchat24 çalışma alanı adını,
        etkilenen kanalı ve sorunun kısa açıklamasını paylaşın. E-posta ile
        parola, erişim belirteci veya WhatsApp kimlik bilgisi göndermeyin.
      </p>
    </main>
  );
}
