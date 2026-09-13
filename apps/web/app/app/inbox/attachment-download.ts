export function triggerAttachmentDownload(
  url: string,
  ownerDocument: Document = document,
) {
  const anchor = ownerDocument.createElement("a");
  const target = new URL(url, ownerDocument.baseURI);
  if (target.pathname === '/api/v1/media/object') target.searchParams.set('download', '1');
  anchor.href = target.toString();
  anchor.download = "";
  anchor.hidden = true;
  ownerDocument.body.append(anchor);
  anchor.click();
  anchor.remove();
}
