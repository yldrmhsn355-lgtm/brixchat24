import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gizlilik Politikası | Brixchat24",
  description: "Brixchat24 gizlilik politikası.",
};

export default function PrivacyPage() {
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
      <h1>Gizlilik Politikası</h1>
      <p>Son güncelleme: 16 Ağustos 2026</p>
      <h2>1. Kapsam</h2>
      <p>
        Brixchat24, ekiplerin müşteri iletişimlerini yönetmesine yardımcı olan
        bir ortak gelen kutusu ve WhatsApp entegrasyonudur. Bu politika,
        hizmetimizi kullanırken işlenen kişisel verileri açıklar.
      </p>
      <h2>2. İşlenen veriler</h2>
      <p>
        Hesap bilgileri, ekip üyeleri, iletişim bilgileri, müşteri mesajları,
        kanal ve teslimat kayıtları; hizmeti sunmak, güvenliği sağlamak ve
        destek vermek amacıyla işlenebilir.
      </p>
      <h2>3. WhatsApp verileri</h2>
      <p>
        WhatsApp Business API üzerinden alınan mesajlar yalnızca yetkili kuruluş
        hesabının gelen kutusunu işletmek, yanıt göndermek ve teslimat
        durumlarını göstermek için kullanılır. Bu veriler reklam amacıyla
        satılmaz veya kiralanmaz.
      </p>
      <h2>4. Saklama ve güvenlik</h2>
      <p>
        Veriler, hesabın aktif olduğu süre ve yasal yükümlülükler için gerekli
        süre boyunca saklanır. Erişim kontrolleri, şifreleme ve denetim
        kayıtları ile korunur.
      </p>
      <h2>5. Haklarınız ve iletişim</h2>
      <p>
        Brixchat24 hizmetinin veri sorumlusu Hasan Yıldırım&apos;dır (Türkiye).
        Verilerinize erişim, düzeltme, silme, kısıtlama veya itiraz
        talepleriniz için hesap yöneticiniz üzerinden ya da
        {" "}
        <a href="mailto:hsnyldrm-590@hotmail.com">
          hsnyldrm-590@hotmail.com
        </a>
        {" "}
        adresinden iletişime geçebilirsiniz.
      </p>
    </main>
  );
}
