export function formatAudioTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function shouldSubmitComposer(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const AUDIO_PLAYBACK_RATES = [1, 1.5, 2] as const;

export function nextAudioPlaybackRate(value: number) {
  const index = AUDIO_PLAYBACK_RATES.indexOf(
    value as (typeof AUDIO_PLAYBACK_RATES)[number],
  );
  return AUDIO_PLAYBACK_RATES[(index + 1) % AUDIO_PLAYBACK_RATES.length] ?? 1;
}
