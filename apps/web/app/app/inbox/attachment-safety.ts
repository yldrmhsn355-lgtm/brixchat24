export type AttachmentSafetyState = {
  status: string;
  scanStatus: string;
};

export function isAttachmentDownloadable(
  attachment: AttachmentSafetyState,
) {
  return attachment.status === "stored" && attachment.scanStatus === "clean";
}
