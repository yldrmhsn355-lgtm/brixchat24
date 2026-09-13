import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FolderPolicyService,
  GoogleDriveAdapter,
  StorageProviderRegistry,
  StorageProviderError,
  createGoogleOAuthState,
  googleAuthorizationUrl,
  hasGoogleDriveWriteScope,
  hashGoogleOAuthState,
} from "./index";

afterEach(() => vi.unstubAllGlobals());

describe("StorageProviderRegistry", () => {
  it("resolves registered providers without exposing provider SDKs", () => {
    const registry = new StorageProviderRegistry();
    const provider = {} as GoogleDriveAdapter;
    registry.register("google_drive", () => provider);
    expect(registry.create("google_drive")).toBe(provider);
    expect(() => registry.create("dropbox")).toThrow(
      "STORAGE_PROVIDER_UNSUPPORTED",
    );
  });
});

describe("FolderPolicyService", () => {
  it("sanitizes names and never embeds the full phone number", () => {
    const policy = new FolderPolicyService();
    const result = policy.contactFolders({
      contactId: "d176adab-3f84-4f5f-9a55-0412c28ab025",
      displayName: "../Ayşe / Yılmaz",
      normalizedPhone: "+905551234567",
      year: 2026,
    });
    expect(result.rootName).toBe("2026");
    expect(result.contactName).toMatch(/^D176ADAB - Ayşe _ Yılmaz$/);
    expect(result.contactName).not.toContain("905551234567");
    expect(result.categories).toHaveLength(8);
    expect(
      policy.fileName({
        date: new Date("2026-08-01T10:00:00Z"),
        contactCode: "D176ADAB",
        category: "Xray CBCT",
        version: 2,
        extension: ".PDF",
      }),
    ).toBe("2026-08-01_D176ADAB_XRAY_CBCT_v2.pdf");
  });
});

describe("GoogleDriveAdapter", () => {
  it("refreshes once and retries a replayable request after a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "drive-file",
            name: "scan.pdf",
            mimeType: "application/pdf",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const refreshAccessToken = vi.fn().mockResolvedValue("fresh-access");
    const adapter = new GoogleDriveAdapter({
      accessToken: "stale-access",
      refreshAccessToken,
      fetch: fetchMock,
    });

    await expect(adapter.getMetadata("drive-file")).resolves.toMatchObject({
      id: "drive-file",
    });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject(
      { authorization: "Bearer stale-access" },
    );
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject(
      { authorization: "Bearer fresh-access" },
    );
  });

  it("does not hide a provider error raised while refreshing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const refreshAccessToken = vi
      .fn()
      .mockRejectedValue(
        new StorageProviderError(
          "GOOGLE_TOKEN_REVOKED",
          "Google access must be renewed.",
          false,
        ),
      );
    const adapter = new GoogleDriveAdapter({
      accessToken: "stale-access",
      refreshAccessToken,
      fetch: fetchMock,
    });

    await expect(adapter.getMetadata("drive-file")).rejects.toMatchObject({
      code: "GOOGLE_TOKEN_REVOKED",
      retryable: false,
    });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a resumable session and streams the upload body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { location: "https://upload.example/session" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "drive-file",
            name: "scan.pdf",
            mimeType: "application/pdf",
            size: "12",
            parents: ["folder"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new GoogleDriveAdapter({
      accessToken: "access",
      fetch: fetchMock,
    });
    const stored = await adapter.upload({
      name: "scan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12,
      parentId: "folder",
      body: Readable.toWeb(
        Readable.from(Buffer.from("hello world!")),
      ) as ReadableStream<Uint8Array>,
    });
    expect(stored.id).toBe("drive-file");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("uploadType=resumable");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://upload.example/session");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBeInstanceOf(
      ReadableStream,
    );
  });

  it("maps provider quota errors to stable domain codes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "quota",
            errors: [{ reason: "storageQuotaExceeded" }],
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new GoogleDriveAdapter({
      accessToken: "access",
      fetch: fetchMock,
    });
    await expect(adapter.getMetadata("missing")).rejects.toMatchObject({
      code: "GOOGLE_QUOTA_EXCEEDED",
      retryable: true,
    } satisfies Partial<StorageProviderError>);
  });

  it("keeps public sharing disabled unless explicitly enabled", async () => {
    const adapter = new GoogleDriveAdapter({ accessToken: "access" });
    await expect(
      adapter.createShareLink({ fileId: "drive-file" }),
    ).rejects.toMatchObject({
      code: "DRIVE_PERMISSION_DENIED",
      retryable: false,
    } satisfies Partial<StorageProviderError>);
  });
});

describe("Google OAuth", () => {
  it("uses one-way state validation and least-privilege offline consent", () => {
    const state = createGoogleOAuthState();
    expect(state.value).not.toBe(state.hash);
    expect(hashGoogleOAuthState(state.value)).toBe(state.hash);

    const url = new URL(
      googleAuthorizationUrl({
        clientId: "client",
        redirectUri: "https://app.example.test/callback",
        state: state.value,
        promptConsent: true,
      }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("scope")).toContain("drive.file");
    expect(url.searchParams.get("scope")).not.toContain("drive.readonly");
    expect(url.searchParams.get("state")).toBe(state.value);
  });

  it("requires a Drive write scope in the granted token", () => {
    expect(
      hasGoogleDriveWriteScope([
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
      ]),
    ).toBe(false);
    expect(
      hasGoogleDriveWriteScope([
        "openid",
        "https://www.googleapis.com/auth/drive.file",
      ]),
    ).toBe(true);
    expect(
      hasGoogleDriveWriteScope(["https://www.googleapis.com/auth/drive"]),
    ).toBe(true);
  });
});
