"use client";

import { useEffect, useId, useState } from "react";
import { apiJson } from "../lib/api";

export interface AiModelOption {
  id: string;
  name: string;
  contextLength: number | null;
  promptPerMillion: string | null;
  completionPerMillion: string | null;
}

let catalogCache: AiModelOption[] | null = null;
let catalogPending: Promise<AiModelOption[]> | null = null;

async function loadModelCatalog(): Promise<AiModelOption[]> {
  if (catalogCache) return catalogCache;
  catalogPending ??= apiJson<{ data: AiModelOption[] }>("/api/v1/ai/models")
    .then((result) => {
      catalogCache = result.data ?? [];
      return catalogCache;
    })
    .finally(() => {
      catalogPending = null;
    });
  return catalogPending;
}

function formatModelMeta(model: AiModelOption): string {
  const parts: string[] = [];
  if (model.contextLength) {
    parts.push(`${Math.round(model.contextLength / 1000)}k bağlam`);
  }
  if (model.promptPerMillion !== null && model.completionPerMillion !== null) {
    parts.push(
      model.promptPerMillion === "0" && model.completionPerMillion === "0"
        ? "ücretsiz"
        : `$${model.promptPerMillion} / $${model.completionPerMillion} (1M jeton, girdi/çıktı)`,
    );
  }
  return parts.join(" · ");
}

/**
 * OpenRouter model input with a searchable suggestion list. Free text stays
 * allowed so brand-new model ids work before the catalog refreshes; when the
 * value matches a known model its context window and pricing are shown.
 */
export function AiModelInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const listId = useId();
  const [models, setModels] = useState<AiModelOption[]>(catalogCache ?? []);

  useEffect(() => {
    let alive = true;
    void loadModelCatalog()
      .then((catalog) => {
        if (alive) setModels(catalog);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const selected = models.find((model) => model.id === value.trim());

  return (
    <>
      <input
        list={listId}
        value={value}
        placeholder={placeholder ?? "openai/gpt-4o-mini"}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </datalist>
      {selected ? (
        <small className="ai-note">
          {selected.name}
          {formatModelMeta(selected) ? ` · ${formatModelMeta(selected)}` : ""}
        </small>
      ) : models.length > 0 && value.trim() ? (
        <small className="ai-note">
          Listede yok — yeni bir model kimliği kullanıyorsanız sorun değil.
        </small>
      ) : null}
    </>
  );
}
