export function normalizeShortcut(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
}

export function insertQuickReplyAtCursor(
  draft: string,
  content: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; cursor: number } {
  const before = draft.slice(0, selectionStart);
  const slash = before.lastIndexOf("/");
  const tokenStart =
    slash >= 0 && !/\s/.test(before.slice(slash + 1)) ? slash : selectionStart;
  const left = draft.slice(0, tokenStart);
  const right = draft.slice(selectionEnd);
  const separator =
    left && !/\s$/.test(left) && content && !/^\s/.test(content) ? " " : "";
  const value = `${left}${separator}${content}${right}`;
  return { value, cursor: left.length + separator.length + content.length };
}

export function unresolvedVariables(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(
        (match) => match[1]!,
      ),
    ),
  ];
}

export function parseCsvRecords(value: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((item) => item.trim())) rows.push(row);
  const [rawHeader, ...data] = rows;
  if (!rawHeader) return [];
  const header = rawHeader.map((item, index) =>
    item.replace(/^\uFEFF/, "").trim() || `field_${index}`,
  );
  return data.map((values) =>
    Object.fromEntries(
      header.map((key, index) => [key, values[index]?.trim() ?? ""]),
    ),
  );
}
