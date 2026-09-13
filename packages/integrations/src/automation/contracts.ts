import { z } from "zod";

export const automationNodeCategorySchema = z.enum([
  "trigger",
  "condition",
  "time",
  "messaging",
  "assignment",
  "conversation",
  "crm",
  "integration",
  "control",
  "ai",
  "error",
]);

const inputPortSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    kind: z.enum(["control", "data"]),
    required: z.boolean(),
  })
  .strict();

const outputPortSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    kind: z.enum([
      "success",
      "true",
      "false",
      "case",
      "timeout",
      "error",
      "cancelled",
    ]),
    required: z.boolean(),
  })
  .strict();

function uniquePortIds(
  ports: ReadonlyArray<{ id: string }>,
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, port] of ports.entries()) {
    if (seen.has(port.id)) {
      context.addIssue({
        code: "custom",
        message: `automation_port_duplicate:${port.id}`,
        path: [index, "id"],
      });
    }
    seen.add(port.id);
  }
}

export const automationNodeContractSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    type: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    version: z.number().int().min(1).max(1_000),
    category: automationNodeCategorySchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
    position: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
      })
      .strict(),
    config: z.record(z.string(), z.unknown()),
    inputPorts: z.array(inputPortSchema).max(32),
    outputPorts: z.array(outputPortSchema).max(64),
    retryPolicy: z
      .object({
        maxAttempts: z.number().int().min(1).max(20),
        backoffMs: z.number().int().min(1_000).max(300_000),
        maxBackoffMs: z.number().int().min(1_000).max(300_000),
      })
      .strict()
      .refine(
        (value) => value.maxBackoffMs >= value.backoffMs,
        "automation_retry_backoff_invalid",
      ),
    timeoutPolicy: z
      .object({
        timeoutMs: z.number().int().min(1_000).max(2_592_000_000).nullable(),
      })
      .strict(),
    errorPolicy: z
      .object({
        mode: z.enum(["fail", "continue", "route"]),
      })
      .strict(),
    uiMetadata: z
      .object({
        label: z.string().trim().min(1).max(160),
        icon: z.string().trim().min(1).max(80),
        color: z.string().trim().min(1).max(80),
      })
      .strict(),
    runtimeMetadata: z
      .object({
        capability: z.enum(["production", "dry-run-only", "planned"]),
        handlerKey: z.string().trim().min(1).max(160).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((node, context) => {
    uniquePortIds(node.inputPorts, context);
    uniquePortIds(node.outputPorts, context);
    if (
      node.runtimeMetadata.capability === "production" &&
      !node.runtimeMetadata.handlerKey
    ) {
      context.addIssue({
        code: "custom",
        message: "automation_runtime_handler_missing",
        path: ["runtimeMetadata", "handlerKey"],
      });
    }
  });

export type AutomationPlatformNodeCategory = z.infer<
  typeof automationNodeCategorySchema
>;
export type AutomationNodeContract = z.infer<
  typeof automationNodeContractSchema
>;
export type AutomationInputPort = AutomationNodeContract["inputPorts"][number];
export type AutomationOutputPort =
  AutomationNodeContract["outputPorts"][number];

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>))
      deepFreeze(nested);
  }
  return value;
}

export function parseAutomationNodeContract(
  input: unknown,
): AutomationNodeContract {
  return deepFreeze(automationNodeContractSchema.parse(input));
}
