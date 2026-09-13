export type StudioPaletteCategory =
  | "trigger"
  | "condition"
  | "action"
  | "delay"
  | "end";

export type StudioNodeCatalogEntry = {
  type: string;
  version: number;
  displayName: string;
  description: string;
  category: string;
  availability: string;
  runtimeCapability: string;
  configSchema?: Record<string, unknown>;
  inputPorts?: Array<Record<string, unknown>>;
  outputPorts?: Array<Record<string, unknown>>;
};

const groups: Array<{
  sourceCategories: string[];
  category: StudioPaletteCategory;
  title: string;
}> = [
  {
    sourceCategories: ["trigger"],
    category: "trigger",
    title: "Tetikleyiciler",
  },
  {
    sourceCategories: ["condition"],
    category: "condition",
    title: "Koşullar",
  },
  {
    sourceCategories: ["time"],
    category: "delay",
    title: "Zaman ve SLA",
  },
  {
    sourceCategories: [
      "messaging",
      "assignment",
      "conversation",
      "crm",
      "integration",
    ],
    category: "action",
    title: "Aksiyonlar",
  },
  {
    sourceCategories: ["control", "error"],
    category: "end",
    title: "Akış kontrolü",
  },
  {
    sourceCategories: ["ai"],
    category: "action",
    title: "Yapay zekâ",
  },
];

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("tr-TR").trim();
}

export function buildStudioPalette(
  nodes: readonly StudioNodeCatalogEntry[],
  search: string,
) {
  const query = normalize(search);
  return groups
    .map((group) => ({
      title: group.title,
      category: group.category,
      items: nodes
        .filter((node) => group.sourceCategories.includes(node.category))
        .filter(
          (node) =>
            !query ||
            normalize(`${node.displayName} ${node.description}`).includes(query),
        )
        .map((node) => ({
          type: node.type,
          version: node.version,
          label: node.displayName,
          description: node.description,
          disabled:
            node.availability !== "available" ||
            node.runtimeCapability !== "production",
          runtimeCapability: node.runtimeCapability,
          configSchema: node.configSchema,
        })),
    }))
    .filter((group) => group.items.length);
}
