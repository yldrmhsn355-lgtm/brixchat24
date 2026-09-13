export interface CampaignRecipientInput {
  phone: string;
  name: string;
}

export interface CampaignCsvPreview {
  recipients: CampaignRecipientInput[];
  duplicates: number;
  errors: Array<{ row: number; message: string }>;
}

export const CAMPAIGN_RECIPIENT_LIMIT = 1000;

/** Require an explicit international number: never guess the customer's country. */
export function normalizeCampaignPhone(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, "");
  const international = compact.startsWith("00")
    ? `+${compact.slice(2)}`
    : compact;
  return /^\+[1-9]\d{7,14}$/.test(international) ? international : null;
}

/** RFC-style quoted fields, CRLF, embedded newlines, UTF-8 BOM and Turkish headers. */
export function previewCampaignCsv(source: string): CampaignCsvPreview {
  const text = source.replace(/^\uFEFF/, "");
  if (text.length > 1_000_000)
    throw new Error("CSV dosyası en fazla 1 MB olabilir.");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter =
    firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const pushField = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const pushRow = () => {
    pushField();
    if (row.some((cell) => cell.trim())) rows.push(row);
    row = [];
    if (rows.length > CAMPAIGN_RECIPIENT_LIMIT + 1)
      throw new Error("CSV en fazla 1000 alıcı içerebilir.");
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else field += char;
    } else if (char === delimiter) pushField();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      pushRow();
    } else if (char === '"' && !field && !closed) quoted = true;
    else {
      if (closed || char === '"')
        throw new Error("CSV tırnak biçimi geçersiz.");
      field += char;
    }
  }
  if (quoted) throw new Error("CSV içinde kapatılmamış tırnak var.");
  if (field || row.length || closed) pushRow();
  const headers = (rows.shift() ?? []).map((value) =>
    value.trim().toLocaleLowerCase("tr-TR"),
  );
  const phoneIndex = headers.findIndex((value) =>
    ["phone", "telefon", "numara"].includes(value),
  );
  const nameIndex = headers.findIndex((value) =>
    ["name", "ad", "isim", "ad soyad"].includes(value),
  );
  if (phoneIndex < 0)
    throw new Error("CSV başlığında telefon veya phone sütunu bulunmalıdır.");
  const preview: CampaignCsvPreview = {
    recipients: [],
    duplicates: 0,
    errors: [],
  };
  const seen = new Set<string>();
  rows.forEach((cells, index) => {
    const phone = normalizeCampaignPhone(cells[phoneIndex] ?? "");
    const name = (nameIndex >= 0 ? (cells[nameIndex] ?? "") : "").trim();
    if (cells.length !== headers.length)
      preview.errors.push({
        row: index + 2,
        message: "Sütun sayısı başlıkla eşleşmiyor.",
      });
    else if (!phone)
      preview.errors.push({
        row: index + 2,
        message: "Telefonu +90 gibi ülke koduyla girin.",
      });
    else if (name.length > 120)
      preview.errors.push({
        row: index + 2,
        message: "İsim en fazla 120 karakter olabilir.",
      });
    else if (seen.has(phone)) preview.duplicates++;
    else {
      seen.add(phone);
      preview.recipients.push({ phone, name });
    }
  });
  return preview;
}
