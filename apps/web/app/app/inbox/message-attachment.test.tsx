import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MessageAttachmentCard,
  type MessageAttachment,
} from "./message-attachment";

const baseAttachment: MessageAttachment = {
  id: "attachment-1",
  type: "image",
  filename: "müşteri-fotoğrafı.jpg",
  mimeType: "image/jpeg",
  status: "stored",
  scanStatus: "clean",
  size: 2048,
};

const defaultProps = {
  downloadable: true,
  activeAudioId: null,
  onActiveAudioChange: vi.fn(),
  onDownload: vi.fn(),
};

describe("MessageAttachmentCard", () => {
  it("renders an accessible image preview and download action", () => {
    const html = renderToStaticMarkup(
      <MessageAttachmentCard
        {...defaultProps}
        attachment={baseAttachment}
        thumbnailUrl="https://cdn.example.com/thumbnail.jpg"
        mediaUrl="https://cdn.example.com/photo.jpg"
      />,
    );

    expect(html).toContain("görselini büyüt");
    expect(html).toContain("dosyasını indir");
    expect(html).toContain("image-message-card");
    expect(html).toContain("image-expand-hint");
    expect(html).toContain("media-overlay-action");
  });

  it("uses the signed full-size image when an outbound upload has no thumbnail", () => {
    const html = renderToStaticMarkup(
      <MessageAttachmentCard
        {...defaultProps}
        attachment={baseAttachment}
        mediaUrl="https://cdn.example.com/outbound-upload.jpg"
      />,
    );

    expect(html).toContain(
      'src="https://cdn.example.com/outbound-upload.jpg"',
    );
    expect(html).toContain("image-preview-button");
    expect(html).not.toContain("media-loading");
  });

  it("renders a voice player with semantic controls", () => {
    const html = renderToStaticMarkup(
      <MessageAttachmentCard
        {...defaultProps}
        attachment={{
          ...baseAttachment,
          type: "voice",
          filename: "voice-message.ogg",
          mimeType: "audio/ogg",
        }}
        mediaUrl="https://cdn.example.com/voice.ogg"
      />,
    );

    expect(html).toContain("Ses kaydını oynat");
    expect(html).toContain("Ses kaydı konumu");
    expect(html).toContain("Sesli mesaj");
    expect(html).toContain("0:00 / 0:00");
    expect(html).toContain("Oynatma hızı 1x");
    expect(html.match(/class="voice-waveform"/g)).toHaveLength(1);
    expect(html).toContain("voice-waveform-control");
    expect(html).toContain("voice-progress-dot");
    expect(html.match(/<i(?:\s|>)/g)).toHaveLength(32);
    expect(html).toContain('aria-valuetext="0:00 / 0:00"');
  });

  it("renders a WhatsApp-style video preview with playback and download controls", () => {
    const html = renderToStaticMarkup(
      <MessageAttachmentCard
        {...defaultProps}
        attachment={{
          ...baseAttachment,
          type: "video",
          filename: "holiday.mp4",
          mimeType: "video/mp4",
        }}
        mediaUrl="https://cdn.example.com/holiday.mp4"
        thumbnailUrl="https://cdn.example.com/holiday-poster.jpg"
      />,
    );

    expect(html).toContain("video-preview-shell");
    expect(html).toContain("holiday.mp4 videosunu oynat");
    expect(html).toContain("video-duration-badge");
    expect(html).toContain("media-overlay-action");
    expect(html).toContain("playsInline");
    expect(html).toContain('poster="https://cdn.example.com/holiday-poster.jpg"');
  });
});
