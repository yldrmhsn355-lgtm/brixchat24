const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
};

export function bitrixTimelineFilename(filename: string, mimeType: string) {
  const cleanFilename = filename.trim() || "whatsapp-attachment";
  if (/\.[a-z0-9]{1,10}$/i.test(cleanFilename)) return cleanFilename;
  return `${cleanFilename}${MIME_EXTENSIONS[mimeType.toLowerCase()] ?? ".bin"}`;
}
