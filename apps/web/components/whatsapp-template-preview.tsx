"use client";

import styles from "./whatsapp-template-preview.module.css";

export type PreviewComponent = {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  text?: string;
  buttons?: Array<{ type?: string; text?: string; url?: string; phone_number?: string }>;
};

function renderExamples(text: string, examples: Record<string, string>) {
  return text.replace(/\{\{(\d+)\}\}/g, (token, position: string) => {
    return examples[`body.${position}`] || token;
  });
}

export function WhatsAppTemplatePreview({
  components,
  examples = {},
  language,
}: {
  components: PreviewComponent[];
  examples?: Record<string, string>;
  language: string;
}) {
  const header = components.find((item) => item.type === "HEADER");
  const body = components.find((item) => item.type === "BODY");
  const footer = components.find((item) => item.type === "FOOTER");
  const buttons = components.find((item) => item.type === "BUTTONS");
  return (
    <section className={styles.phone} aria-label="WhatsApp şablon önizlemesi">
      <div className={styles.top}>
        <span aria-hidden="true">‹</span>
        <span className={styles.avatar}>B</span>
        <span>
          <strong>BRIXCHAT24</strong>
          <small>WhatsApp Business</small>
        </span>
      </div>
      <div className={styles.wallpaper}>
        <article className={styles.bubble}>
          {header?.format && header.format !== "TEXT" ? (
            <div className={styles.media}>
              {header.format === "IMAGE" && "Görsel başlık"}
              {header.format === "VIDEO" && "Video başlık"}
              {header.format === "DOCUMENT" && "Belge başlık"}
              {header.format === "LOCATION" && "Konum"}
            </div>
          ) : header?.text ? (
            <strong className={styles.header}>{header.text}</strong>
          ) : null}
          <p>{renderExamples(body?.text ?? "Mesaj içeriği", examples)}</p>
          {footer?.text ? <small className={styles.footer}>{footer.text}</small> : null}
          <time>12:34 ✓✓</time>
          {buttons?.buttons?.map((button, index) => (
            <button type="button" key={`${button.text}-${index}`}>
              {button.text || "Buton"}
            </button>
          ))}
        </article>
      </div>
      <footer className={styles.language}>Önizleme dili: {language}</footer>
    </section>
  );
}
