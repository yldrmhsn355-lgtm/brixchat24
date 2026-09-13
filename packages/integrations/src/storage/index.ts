import { createHash, randomBytes } from "node:crypto";

export type StorageProviderKey = "google_drive" | (string & {});
export type FileCategory =
  | "incoming_media"
  | "intraoral_photos"
  | "xray_cbct"
  | "treatment_plans"
  | "offers"
  | "consent_reports"
  | "invoices_payments"
  | "other";

export interface UploadInput {
  name: string;
  mimeType: string;
  body: ReadableStream<Uint8Array>;
  sizeBytes?: number;
  parentId?: string;
  metadata?: Record<string, string>;
}
export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  parentIds: string[];
  webViewLink?: string;
  checksum?: string;
}
export type FileMetadata = StoredFile & {
  trashed: boolean;
  modifiedAt?: string;
};
export interface ListFilesInput {
  folderId?: string;
  pageSize?: number;
  pageToken?: string;
  query?: string;
  sharedDriveId?: string;
}
export interface CreateFolderInput {
  name: string;
  parentId?: string;
}
export interface Folder {
  id: string;
  name: string;
}
export interface ShareLinkInput {
  fileId: string;
  role?: "reader" | "commenter" | "writer";
  emailAddress?: string;
  allowPublic?: boolean;
}
export interface ShareLink {
  permissionId: string;
  url: string;
}
export interface StorageProvider {
  upload(input: UploadInput): Promise<StoredFile>;
  download(fileId: string): Promise<ReadableStream<Uint8Array>>;
  getMetadata(fileId: string): Promise<FileMetadata>;
  listFiles(input: ListFilesInput): Promise<FileMetadata[]>;
  createFolder(input: CreateFolderInput): Promise<Folder>;
  move(fileId: string, folderId: string): Promise<void>;
  rename(fileId: string, name: string): Promise<void>;
  archive(fileId: string): Promise<void>;
  delete(fileId: string): Promise<void>;
  restore(fileId: string): Promise<void>;
  createShareLink(input: ShareLinkInput): Promise<ShareLink>;
  revokeShareLink(permissionId: string, fileId?: string): Promise<void>;
}

export type StorageErrorCode =
  | "GOOGLE_TOKEN_REVOKED"
  | "GOOGLE_TOKEN_REFRESH_FAILED"
  | "GOOGLE_QUOTA_EXCEEDED"
  | "DRIVE_FOLDER_NOT_FOUND"
  | "DRIVE_FILE_NOT_FOUND"
  | "DRIVE_PERMISSION_DENIED"
  | "DRIVE_CONNECTION_DISABLED"
  | "WHATSAPP_MEDIA_EXPIRED"
  | "WHATSAPP_MEDIA_UPLOAD_FAILED"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_MIME_TYPE"
  | "INVALID_FILE_CONTENT"
  | "CHECKSUM_MISMATCH"
  | "MALWARE_DETECTED"
  | "NETWORK_TIMEOUT"
  | "UPLOAD_SESSION_EXPIRED"
  | "TENANT_ACCESS_DENIED"
  | "FILE_PROCESSING_FAILED";

export class StorageProviderError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageProviderError";
  }
}

export class StorageProviderRegistry {
  private readonly factories = new Map<string, () => StorageProvider>();
  register(key: StorageProviderKey, factory: () => StorageProvider) {
    if (this.factories.has(key)) throw new Error("STORAGE_PROVIDER_DUPLICATE");
    this.factories.set(key, factory);
    return this;
  }
  create(key: StorageProviderKey) {
    const factory = this.factories.get(key);
    if (!factory) throw new Error("STORAGE_PROVIDER_UNSUPPORTED");
    return factory();
  }
}

const categoryFolders = [
  "01_Incoming_Media",
  "02_Intraoral_Photos",
  "03_Xray_CBCT",
  "04_Treatment_Plans",
  "05_Offers",
  "06_Consent_Reports",
  "07_Invoices_Payments",
  "08_Other",
] as const;

export class FolderPolicyService {
  sanitize(value: string, fallback = "Unnamed") {
    return (
      value
        .normalize("NFKC")
        .replace(/[\\/\0<>:"|?*\x00-\x1f]/g, "_")
        .replace(/^[._\s]+/, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || fallback
    );
  }
  contactCode(contactId: string) {
    return contactId.replaceAll("-", "").slice(0, 8).toUpperCase();
  }
  contactFolders(input: {
    contactId: string;
    displayName: string;
    normalizedPhone?: string;
    year?: number;
  }) {
    const contactCode = this.contactCode(input.contactId);
    return {
      rootName: String(input.year ?? new Date().getUTCFullYear()),
      contactCode,
      contactName: `${contactCode} - ${this.sanitize(input.displayName, "Contact")}`,
      categories: [...categoryFolders],
    };
  }
  fileName(input: {
    date: Date;
    contactCode: string;
    category: string;
    version: number;
    extension: string;
  }) {
    const category = this.sanitize(input.category)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const extension = input.extension.replace(/^\./, "").toLowerCase();
    return `${input.date.toISOString().slice(0, 10)}_${this.sanitize(input.contactCode).toUpperCase()}_${category}_v${Math.max(1, input.version)}.${extension}`;
  }
}

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
  md5Checksum?: string;
  trashed?: boolean;
  modifiedTime?: string;
};

export class GoogleDriveAdapter implements StorageProvider {
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly options: {
      accessToken: string | (() => Promise<string>);
      refreshAccessToken?: () => Promise<string>;
      sharedDriveId?: string;
      fetch?: typeof fetch;
    },
  ) {
    this.fetcher = options.fetch ?? fetch;
  }
  private async token() {
    return typeof this.options.accessToken === "function"
      ? this.options.accessToken()
      : this.options.accessToken;
  }
  private async request(url: string, init: RequestInit = {}) {
    let response: Response;
    const execute = (accessToken: string) =>
      this.fetcher(url, {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...init.headers,
        },
      });
    try {
      response = await execute(await this.token());
      const bodyCanBeRetried =
        init.body == null ||
        typeof init.body === "string" ||
        init.body instanceof URLSearchParams;
      if (
        response.status === 401 &&
        bodyCanBeRetried &&
        this.options.refreshAccessToken
      )
        response = await execute(await this.options.refreshAccessToken());
    } catch (error) {
      if (error instanceof StorageProviderError) throw error;
      throw new StorageProviderError(
        "NETWORK_TIMEOUT",
        "Google Drive is temporarily unavailable.",
        true,
        { cause: error },
      );
    }
    if (response.ok) return response;
    let detail: {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    } = {};
    try {
      detail = (await response.json()) as typeof detail;
    } catch {}
    const reason = detail.error?.errors?.[0]?.reason ?? "";
    const message = detail.error?.message ?? "Google Drive request failed.";
    if (response.status === 401)
      throw new StorageProviderError("GOOGLE_TOKEN_REVOKED", message, false);
    if (response.status === 429 || reason.toLowerCase().includes("quota"))
      throw new StorageProviderError("GOOGLE_QUOTA_EXCEEDED", message, true);
    if (response.status === 404)
      throw new StorageProviderError("DRIVE_FILE_NOT_FOUND", message, false);
    if (response.status === 403)
      throw new StorageProviderError("DRIVE_PERMISSION_DENIED", message, false);
    if (response.status === 408 || response.status >= 500)
      throw new StorageProviderError("NETWORK_TIMEOUT", message, true);
    throw new StorageProviderError("FILE_PROCESSING_FAILED", message, false);
  }
  private fields() {
    return "id,name,mimeType,size,parents,webViewLink,md5Checksum,trashed,modifiedTime";
  }
  private file(value: DriveFile): FileMetadata {
    return {
      id: value.id,
      name: value.name ?? "file",
      mimeType: value.mimeType ?? "application/octet-stream",
      sizeBytes: value.size ? Number(value.size) : null,
      parentIds: value.parents ?? [],
      ...(value.webViewLink ? { webViewLink: value.webViewLink } : {}),
      ...(value.md5Checksum ? { checksum: value.md5Checksum } : {}),
      trashed: value.trashed === true,
      ...(value.modifiedTime ? { modifiedAt: value.modifiedTime } : {}),
    };
  }
  async upload(input: UploadInput) {
    const params = new URLSearchParams({
      uploadType: "resumable",
      supportsAllDrives: "true",
      fields: this.fields(),
    });
    const start = await this.request(
      `https://www.googleapis.com/upload/drive/v3/files?${params}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": input.mimeType,
          ...(input.sizeBytes === undefined
            ? {}
            : { "x-upload-content-length": String(input.sizeBytes) }),
        },
        body: JSON.stringify({
          name: input.name,
          ...(input.parentId ? { parents: [input.parentId] } : {}),
          ...(input.metadata ? { appProperties: input.metadata } : {}),
        }),
      },
    );
    const session = start.headers.get("location");
    if (!session)
      throw new StorageProviderError(
        "UPLOAD_SESSION_EXPIRED",
        "Google Drive upload session could not be created.",
        true,
      );
    const uploaded = await this.request(session, {
      method: "PUT",
      headers: {
        "content-type": input.mimeType,
        ...(input.sizeBytes === undefined
          ? {}
          : { "content-length": String(input.sizeBytes) }),
      },
      body: input.body,
      // Required by Node fetch for streaming request bodies.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return this.file((await uploaded.json()) as DriveFile);
  }
  async download(fileId: string) {
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    );
    if (!response.body)
      throw new StorageProviderError(
        "DRIVE_FILE_NOT_FOUND",
        "File has no content.",
        false,
      );
    return response.body;
  }
  async getMetadata(fileId: string) {
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(this.fields())}`,
    );
    return this.file((await response.json()) as DriveFile);
  }
  async listFiles(input: ListFilesInput) {
    const q = [
      "trashed = false",
      input.folderId
        ? `'${input.folderId.replaceAll("'", "\\'")}' in parents`
        : "",
      input.query
        ? `name contains '${input.query.replaceAll("'", "\\'")}'`
        : "",
    ]
      .filter(Boolean)
      .join(" and ");
    const params = new URLSearchParams({
      q,
      pageSize: String(Math.min(100, Math.max(1, input.pageSize ?? 50))),
      fields: `nextPageToken,files(${this.fields()})`,
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (input.pageToken) params.set("pageToken", input.pageToken);
    const driveId = input.sharedDriveId ?? this.options.sharedDriveId;
    if (driveId) {
      params.set("corpora", "drive");
      params.set("driveId", driveId);
    }
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/files?${params}`,
    );
    const body = (await response.json()) as { files?: DriveFile[] };
    return (body.files ?? []).map((file) => this.file(file));
  }
  async createFolder(input: CreateFolderInput) {
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          mimeType: "application/vnd.google-apps.folder",
          ...(input.parentId ? { parents: [input.parentId] } : {}),
        }),
      },
    );
    const value = (await response.json()) as DriveFile;
    return { id: value.id, name: value.name ?? input.name };
  }
  async patch(fileId: string, body: Record<string, unknown>, params = "") {
    await this.request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true${params}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }
  async move(fileId: string, folderId: string) {
    const current = await this.getMetadata(fileId);
    const remove = current.parentIds.join(",");
    await this.patch(
      fileId,
      {},
      `&addParents=${encodeURIComponent(folderId)}${remove ? `&removeParents=${encodeURIComponent(remove)}` : ""}`,
    );
  }
  rename(fileId: string, name: string) {
    return this.patch(fileId, { name });
  }
  archive(fileId: string) {
    return this.patch(fileId, { appProperties: { archived: "true" } });
  }
  delete(fileId: string) {
    return this.patch(fileId, { trashed: true });
  }
  restore(fileId: string) {
    return this.patch(fileId, { trashed: false });
  }
  async createShareLink(input: ShareLinkInput) {
    if (!input.emailAddress && !input.allowPublic)
      throw new StorageProviderError(
        "DRIVE_PERMISSION_DENIED",
        "Public Drive links are disabled by default.",
        false,
      );
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}/permissions?supportsAllDrives=true&fields=id`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: input.emailAddress ? "user" : "anyone",
          role: input.role ?? "reader",
          ...(input.emailAddress ? { emailAddress: input.emailAddress } : {}),
        }),
      },
    );
    const permission = (await response.json()) as { id: string };
    const metadata = await this.getMetadata(input.fileId);
    return {
      permissionId: permission.id,
      url:
        metadata.webViewLink ??
        `https://drive.google.com/open?id=${encodeURIComponent(input.fileId)}`,
    };
  }
  async revokeShareLink(permissionId: string, fileId?: string) {
    if (!fileId) throw new Error("DRIVE_FILE_ID_REQUIRED");
    await this.request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`,
      { method: "DELETE" },
    );
  }
  async getStartPageToken() {
    const response = await this.request(
      "https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true",
    );
    const body = (await response.json()) as { startPageToken?: string };
    if (!body.startPageToken)
      throw new StorageProviderError(
        "FILE_PROCESSING_FAILED",
        "Drive start page token is missing.",
        true,
      );
    return body.startPageToken;
  }
  async listChanges(pageToken: string) {
    const params = new URLSearchParams({
      pageToken,
      spaces: "drive",
      includeRemoved: "true",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${this.fields()}))`,
    });
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/changes?${params}`,
    );
    return (await response.json()) as {
      nextPageToken?: string;
      newStartPageToken?: string;
      changes?: Array<{ fileId: string; removed?: boolean; file?: DriveFile }>;
    };
  }
  async watchChanges(input: {
    pageToken: string;
    channelId: string;
    channelToken: string;
    address: string;
    expiration: Date;
  }) {
    const response = await this.request(
      `https://www.googleapis.com/drive/v3/changes/watch?pageToken=${encodeURIComponent(input.pageToken)}&supportsAllDrives=true`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: input.channelId,
          type: "web_hook",
          address: input.address,
          token: input.channelToken,
          expiration: String(input.expiration.getTime()),
        }),
      },
    );
    return (await response.json()) as {
      id: string;
      resourceId: string;
      expiration?: string;
    };
  }
  async stopChannel(input: { channelId: string; resourceId: string }) {
    await this.request("https://www.googleapis.com/drive/v3/channels/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: input.channelId,
        resourceId: input.resourceId,
      }),
    });
  }
}

export const GOOGLE_DRIVE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.file",
] as const;

export function hasGoogleDriveWriteScope(scopes: readonly string[]) {
  return scopes.some(
    (scope) =>
      scope === "https://www.googleapis.com/auth/drive" ||
      scope === "https://www.googleapis.com/auth/drive.file",
  );
}

export function googleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string;
  promptConsent?: boolean;
}) {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    access_type: "offline",
    include_granted_scopes: "true",
    scope: GOOGLE_DRIVE_SCOPES.join(" "),
    state: input.state,
    ...(input.promptConsent ? { prompt: "consent" } : {}),
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function createGoogleOAuthState() {
  const value = randomBytes(32).toString("base64url");
  return { value, hash: createHash("sha256").update(value).digest("hex") };
}
export function hashGoogleOAuthState(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function exchangeGoogleAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetch?: typeof fetch;
}) {
  const response = await (input.fetch ?? fetch)(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        code: input.code,
        grant_type: "authorization_code",
      }),
    },
  );
  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    error?: string;
  };
  if (!response.ok || !body.access_token)
    throw new StorageProviderError(
      "GOOGLE_TOKEN_REFRESH_FAILED",
      "Google authorization could not be completed.",
      false,
    );
  return body as Required<Pick<typeof body, "access_token">> & typeof body;
}

export async function refreshGoogleAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
}) {
  const response = await (input.fetch ?? fetch)(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        refresh_token: input.refreshToken,
        grant_type: "refresh_token",
      }),
    },
  );
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!response.ok || !body.access_token)
    throw new StorageProviderError(
      body.error === "invalid_grant"
        ? "GOOGLE_TOKEN_REVOKED"
        : "GOOGLE_TOKEN_REFRESH_FAILED",
      "Google access must be renewed.",
      body.error !== "invalid_grant",
    );
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 3600 };
}
