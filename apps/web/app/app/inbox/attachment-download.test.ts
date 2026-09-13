import { describe, expect, it, vi } from "vitest";
import { triggerAttachmentDownload } from "./attachment-download";

describe("triggerAttachmentDownload", () => {
  it('forces download disposition for local signed playback URLs', () => {
    const anchor={href:'',download:'',hidden:false,click:vi.fn(),remove:vi.fn()};
    const ownerDocument={baseURI:'https://brixchat24.com/',createElement:()=>anchor,body:{append:vi.fn()}} as unknown as Document;
    triggerAttachmentDownload('https://api.brixchat24.com/api/v1/media/object?token=signed',ownerDocument);
    expect(anchor.href).toBe('https://api.brixchat24.com/api/v1/media/object?token=signed&download=1');
  });
  it("clicks a hidden download link without opening a new tab", () => {
    const anchor = {
      href: "",
      download: "unset",
      hidden: false,
      click: vi.fn(),
      remove: vi.fn(),
    };
    const append = vi.fn();
    const ownerDocument = {
      createElement: vi.fn(() => anchor),
      body: { append },
    } as unknown as Document;

    triggerAttachmentDownload(
      "https://storage.example.test/signed-file",
      ownerDocument,
    );

    expect(anchor).toMatchObject({
      href: "https://storage.example.test/signed-file",
      download: "",
      hidden: true,
    });
    expect(append).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
  });
});
