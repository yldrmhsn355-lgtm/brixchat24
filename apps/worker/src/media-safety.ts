import { MediaScanError } from "@brixchat/integrations";

type AttachmentContext = {
  metadata: Record<string, unknown>;
  attachment: unknown | null;
};

export function mediaCleanupRequired(input: {
  storageKey: string | null;
  lastErrorCode: string | null;
  cleanupKeys?: readonly string[];
}) {
  return (
    (input.lastErrorCode === "MEDIA_SCAN_CLEANUP_FAILED" ||
      input.lastErrorCode === "MEDIA_OBJECT_CLEANUP_FAILED") &&
    (Boolean(input.storageKey) || Boolean(input.cleanupKeys?.length))
  );
}

export function mediaStoredClean(input: {
  storageKey: string | null;
  processingStatus: unknown;
  scanStatus: unknown;
}) {
  return (
    Boolean(input.storageKey) &&
    input.processingStatus === "stored" &&
    input.scanStatus === "clean"
  );
}

export function outboundMediaNeedsCleanAttachment(
  context: AttachmentContext,
) {
  return context.metadata.attachment === true && context.attachment === null;
}

export function mediaProcessingFailureDisposition(
  error: unknown,
  attempt: number,
  maxAttempts: number,
) {
  const code = error instanceof Error ? error.message : "MEDIA_ERROR";
  const scanError = error instanceof MediaScanError ? error : null;
  return {
    code,
    dead:
      attempt >= maxAttempts ||
      code.includes("DENIED") ||
      code === "MEDIA_INFECTED",
    scanStatus:
      scanError
        ? scanError.scanStatus
        : code === "MEDIA_INFECTED"
        ? "infected"
        : code === "MEDIA_SCAN_FAILED"
          ? "failed"
          : null,
    cleanupKey: scanError?.cleanupFailed ? (scanError.storageKey ?? null) : null,
  } as const;
}

export function mediaObjectCleanupFailureDisposition(
  failure: ReturnType<typeof mediaProcessingFailureDisposition>,
  storageKey: string,
  attempt: number,
  maxAttempts: number,
) {
  return {
    ...failure,
    code: "MEDIA_OBJECT_CLEANUP_FAILED",
    dead: attempt >= maxAttempts,
    cleanupKey: storageKey,
  } as const;
}
