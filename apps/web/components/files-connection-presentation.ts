export type DriveConnectionState = {
  status: string;
  last_health_check_at: string | null;
  last_error_code: string | null;
};

const reconnectErrors = new Set([
  "GOOGLE_TOKEN_REVOKED",
  "GOOGLE_TOKEN_REFRESH_FAILED",
]);

export function driveConnectionStatus(connection: DriveConnectionState) {
  if (connection.status === "error")
    return {
      className: "error",
      label: reconnectErrors.has(connection.last_error_code ?? "")
        ? "Yeniden bağlanmalı"
        : "Bağlantı hatası",
    };
  if (connection.status === "connected" && connection.last_health_check_at)
    return { className: "connected", label: "Sağlıklı" };
  if (connection.status === "connected")
    return { className: "pending", label: "Bağlı · test edilmedi" };
  return { className: connection.status, label: connection.status };
}

export function driveConnectionError(code: string | null) {
  if (!code) return "—";
  if (code === "DRIVE_SCOPE_MISSING")
    return "Google Drive erişim izni verilmedi. Yeniden bağlanırken Drive erişim kutusunu işaretleyin.";
  if (reconnectErrors.has(code)) return "Google hesabını yeniden bağlayın.";
  if (code === "DRIVE_PERMISSION_DENIED")
    return "Google Drive erişim izni yetersiz.";
  if (code === "GOOGLE_QUOTA_EXCEEDED") return "Google Drive kotası aşıldı.";
  if (code === "NETWORK_TIMEOUT")
    return "Google Drive geçici olarak yanıt vermiyor.";
  return code;
}
