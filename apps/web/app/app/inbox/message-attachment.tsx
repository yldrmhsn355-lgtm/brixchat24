"use client";

import Image from "next/image";
import React from "react";
import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileText,
  ImageIcon,
  Maximize2,
  Pause,
  Play,
  Video,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  formatAttachmentSize,
  formatAudioTime,
  nextAudioPlaybackRate,
} from "./message-presentation";

export type MessageAttachment = {
  id: string;
  type: string;
  filename: string;
  mimeType: string;
  status: string;
  scanStatus: string;
  size: number;
};

type AttachmentProps = {
  attachment: MessageAttachment;
  downloadable: boolean;
  thumbnailUrl?: string | undefined;
  mediaUrl?: string | undefined;
  activeAudioId: string | null;
  onActiveAudioChange: (id: string | null) => void;
  onDownload: (id: string) => void;
};

function AttachmentMeta({
  attachment,
  label,
}: {
  attachment: MessageAttachment;
  label: string;
}) {
  const size = formatAttachmentSize(attachment.size);
  return (
    <span className="media-meta">
      <strong>{label}</strong>
      <small>
        {attachment.filename}
        {size ? ` · ${size}` : ""}
      </small>
    </span>
  );
}

function ImageAttachment({
  attachment,
  downloadable,
  thumbnailUrl,
  mediaUrl,
  onDownload,
}: Pick<
  AttachmentProps,
  "attachment" | "downloadable" | "thumbnailUrl" | "mediaUrl" | "onDownload"
>) {
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const previewUrl = thumbnailUrl || mediaUrl;

  useEffect(() => {
    if (!expanded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        setZoom(1);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [expanded]);

  return (
    <div className="media-card image-message-card">
      {previewUrl ? (
        <button
          type="button"
          className="image-preview-button"
          aria-label={`${attachment.filename} görselini büyüt`}
          onClick={() => setExpanded(true)}
        >
          <Image
            src={previewUrl}
            alt={attachment.filename}
            width={480}
            height={360}
            sizes="(max-width: 720px) 78vw, 420px"
            unoptimized
            className="media-preview"
          />
          <span className="image-expand-hint" aria-hidden="true">
            <Maximize2 size={16} />
            <span className="sr-only">Büyüt</span>
          </span>
        </button>
      ) : (
        <div className="media-loading" aria-live="polite">
          <ImageIcon size={20} />
          <span>Görsel hazırlanıyor…</span>
        </div>
      )}
      <button
        type="button"
        className="media-overlay-action"
        aria-label={`${attachment.filename} dosyasını indir`}
        disabled={!downloadable}
        onClick={() => onDownload(attachment.id)}
      >
        <Download size={16} />
      </button>
      {expanded && previewUrl ? (
        <div
          className="media-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${attachment.filename} görsel önizlemesi`}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              setExpanded(false);
              setZoom(1);
            }
          }}
        >
          <div className="media-lightbox-toolbar">
            <span>{attachment.filename}</span>
            <output aria-live="polite">{Math.round(zoom * 100)}%</output>
            <button
              type="button"
              aria-label="Görseli küçült"
              disabled={zoom <= 1}
              onClick={() => setZoom((value) => Math.max(1, value - 0.25))}
            >
              <ZoomOut size={19} />
            </button>
            <button
              type="button"
              aria-label="Görseli büyüt"
              disabled={zoom >= 3}
              onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
            >
              <ZoomIn size={19} />
            </button>
            <button
              type="button"
              aria-label="Görseli indir"
              onClick={() => onDownload(attachment.id)}
            >
              <Download size={19} />
            </button>
            <button
              type="button"
              aria-label="Görsel önizlemesini kapat"
              autoFocus
              onClick={() => {
                setExpanded(false);
                setZoom(1);
              }}
            >
              <X size={21} />
            </button>
          </div>
          <div className="media-lightbox-image">
            <div style={{ transform: `scale(${zoom})` }}>
              <Image
                src={mediaUrl || previewUrl}
                alt={attachment.filename}
                fill
                sizes="95vw"
                unoptimized
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AudioAttachment({
  attachment,
  downloadable,
  mediaUrl,
  activeAudioId,
  onActiveAudioChange,
  onDownload,
}: AttachmentProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playError, setPlayError] = useState(false);
  const resumeAt = useRef(0);
  const isActive = activeAudioId === attachment.id;
  const audioProgress = duration > 0 ? currentTime / duration : 0;
  const audioProgressPercent = Math.min(100, Math.max(0, audioProgress * 100));

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!isActive) {
      audio.pause();
      return;
    }
    setPlayError(false);
    void audio.play().catch(() => { setPlayError(true); onActiveAudioChange(null); });
  }, [isActive, onActiveAudioChange]);

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrentTime(value);
  };

  const cyclePlaybackRate = () => {
    const next = nextAudioPlaybackRate(playbackRate);
    setPlaybackRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  return (
    <div className="media-card voice-message-card">
      {playError && <p role="alert">Ses açılamadı. Tekrar oynatmayı deneyin veya dosyayı indirin.</p>}
      {mediaUrl ? (
        <>
          <audio
            ref={audioRef}
            preload="metadata"
            src={mediaUrl}
            onError={() => { setPlayError(true); onActiveAudioChange(null); }}
            onLoadedMetadata={(event) => {
              const audio = event.currentTarget;
              setPlayError(false);
              audio.playbackRate = playbackRate;
              if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(resumeAt.current, audio.duration);
              setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
              if (isActive) void audio.play().catch(() => { setPlayError(true); onActiveAudioChange(null); });
            }}
            onTimeUpdate={(event) => { if (event.currentTarget.readyState > 0) { resumeAt.current = event.currentTarget.currentTime; setCurrentTime(event.currentTarget.currentTime); } }}
            onEnded={() => {
              resumeAt.current = 0;
              setCurrentTime(0);
              onActiveAudioChange(null);
            }}
          />
          <button
            type="button"
            className="voice-play-button"
            aria-label={isActive ? "Ses kaydını duraklat" : "Ses kaydını oynat"}
            onClick={() => onActiveAudioChange(isActive ? null : attachment.id)}
          >
            {isActive ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <div className="voice-track">
            <span className="voice-label sr-only">
              <Volume2 size={13} />
              {attachment.type === "voice" ? "Sesli mesaj" : "Ses dosyası"}
            </span>
            <span className="voice-waveform-control">
              <span className="voice-waveform" aria-hidden="true">
                {Array.from({ length: 32 }, (_, index) => (
                  <i
                    key={index}
                    className={
                      audioProgress > 0 && index / 31 <= audioProgress
                        ? "active"
                        : undefined
                    }
                    style={{
                      height: `${5 + ((index * 11 + attachment.id.length) % 19)}px`,
                    }}
                  />
                ))}
              </span>
              <span
                className="voice-progress-dot"
                aria-hidden="true"
                style={{ left: `${audioProgressPercent}%` }}
              />
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Math.min(currentTime, duration || 0)}
                aria-label="Ses kaydı konumu"
                aria-valuetext={`${formatAudioTime(currentTime)} / ${formatAudioTime(duration)}`}
                onChange={(event) => seek(Number(event.target.value))}
              />
            </span>
            <span className="voice-time">
              <span>{formatAudioTime(currentTime)}</span>
              <span>{formatAudioTime(duration)}</span>
            </span>
          </div>
          <button
            type="button"
            className="voice-speed-button"
            aria-label={`Oynatma hızı ${playbackRate}x`}
            onClick={cyclePlaybackRate}
          >
            {playbackRate}x
          </button>
          <button
            type="button"
            className="media-action-button"
            aria-label={`${attachment.filename} dosyasını indir`}
            disabled={!downloadable}
            onClick={() => onDownload(attachment.id)}
          >
            <Download size={15} />
          </button>
        </>
      ) : (
        <div className="media-loading" aria-live="polite">
          <Volume2 size={20} />
          <span>Ses kaydı hazırlanıyor…</span>
        </div>
      )}
    </div>
  );
}

function VideoAttachment({
  attachment,
  downloadable,
  mediaUrl,
  thumbnailUrl,
  onDownload,
}: Pick<
  AttachmentProps,
  "attachment" | "downloadable" | "mediaUrl" | "thumbnailUrl" | "onDownload"
>) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [videoError, setVideoError] = useState(false);
  const resumeVideo = useRef({ time: 0, playing: false });

  const play = () => {
    const video = videoRef.current;
    if (!video) return;
    setVideoError(false);
    void video.play().catch(() => { setPlaying(false); setVideoError(true); });
  };

  return (
    <div className="media-card video-message-card">
      {videoError && <p role="alert">Video açılamadı. Tekrar oynatmayı deneyin veya dosyayı indirin.</p>}
      {mediaUrl ? (
        <div className="video-preview-shell">
          <video
            ref={videoRef}
            className="media-preview"
            controls
            playsInline
            preload="metadata"
            src={mediaUrl}
            poster={thumbnailUrl}
            aria-label={attachment.filename}
            onError={() => setVideoError(true)}
            onTimeUpdate={event => { if (event.currentTarget.readyState > 0) resumeVideo.current.time = event.currentTarget.currentTime; }}
            onLoadedMetadata={event => {
              const video = event.currentTarget;
              setVideoError(false);
              setDuration(Number.isFinite(video.duration) ? video.duration : 0);
              if (Number.isFinite(video.duration)) video.currentTime = Math.min(resumeVideo.current.time, video.duration);
              if (resumeVideo.current.playing) void video.play().catch(() => setVideoError(true));
            }}
            onPlay={() => { setPlaying(true); resumeVideo.current.playing = true; }}
            onPause={event => { setPlaying(false); if (event.currentTarget.readyState > 0) resumeVideo.current.playing = false; }}
            onEnded={() => { setPlaying(false); resumeVideo.current = {time:0,playing:false}; }}
          />
          {!playing && (
            <>
              <button
                type="button"
                className="video-play-overlay"
                aria-label={`${attachment.filename} videosunu oynat`}
                onClick={play}
              >
                <Play size={28} fill="currentColor" />
              </button>
              <span className="video-duration-badge" aria-hidden="true">
                {formatAudioTime(duration)}
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="media-loading">
          <Video size={20} />
          <span>Video hazırlanıyor…</span>
        </div>
      )}
      <button
        type="button"
        className="media-overlay-action"
        aria-label={`${attachment.filename} dosyasını indir`}
        disabled={!downloadable}
        onClick={() => onDownload(attachment.id)}
      >
        <Download size={16} />
      </button>
    </div>
  );
}

export function MessageAttachmentCard(props: AttachmentProps) {
  const { attachment, downloadable, mediaUrl, onDownload, thumbnailUrl } =
    props;

  if (attachment.type === "image" || attachment.type === "sticker") {
    return (
      <ImageAttachment
        attachment={attachment}
        downloadable={downloadable}
        thumbnailUrl={thumbnailUrl}
        mediaUrl={mediaUrl}
        onDownload={onDownload}
      />
    );
  }

  if (attachment.type === "audio" || attachment.type === "voice") {
    return <AudioAttachment {...props} />;
  }

  if (attachment.type === "video") {
    return (
      <VideoAttachment
        attachment={attachment}
        downloadable={downloadable}
        mediaUrl={mediaUrl}
        thumbnailUrl={thumbnailUrl}
        onDownload={onDownload}
      />
    );
  }

  return (
    <button
      type="button"
      className="media-card file-message-card"
      disabled={!downloadable}
      onClick={() => onDownload(attachment.id)}
    >
      <span className="file-message-icon">
        <FileText size={20} />
      </span>
      <AttachmentMeta
        attachment={attachment}
        label={downloadable ? "Dosya" : "Medya işleniyor…"}
      />
      <Download size={17} aria-hidden="true" />
    </button>
  );
}
