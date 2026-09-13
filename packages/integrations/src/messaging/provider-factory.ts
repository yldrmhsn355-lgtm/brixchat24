import { ProviderError, type MessagingProvider } from "./types";
import { FakeMessagingProvider, type FakeMode } from "../fake/provider";
import { providerModule } from "./modules";
import {
  requireCreatableProviderDefinition,
  type MessagingProviderDefinition,
} from "./provider-catalog";

type ProviderFactoryInput = {
  provider?: string;
  platform?: string;
  mode?: "fake" | "meta";
  fakeMode?: FakeMode;
  apiVersion?: string;
  allowDevelopmentFake?: boolean;
  timeoutMs?: number;
};

export function createMessagingProvider(
  input: ProviderFactoryInput,
): MessagingProvider {
  const provider = input.provider ?? input.mode;
  const platform =
    input.platform ??
    (provider === "meta" || provider === "fake" ? "whatsapp" : undefined);
  let definition: MessagingProviderDefinition;
  try {
    definition = requireCreatableProviderDefinition({
      provider: provider ?? "",
      ...(platform ? { platform } : {}),
      includeDevelopment:
        input.allowDevelopmentFake === true || input.mode === "fake",
    });
  } catch {
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      false,
      "Messaging provider adapter is not available",
    );
  }
  const module = providerModule(definition.provider, definition.platform);
  if (module?.create)
    return module.create({
      ...(input.apiVersion ? { apiVersion: input.apiVersion } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.fakeMode ? { fakeMode: input.fakeMode } : {}),
    });
  if (
    definition.provider === "fake" &&
    definition.availability === "development_only" &&
    (input.allowDevelopmentFake === true || input.mode === "fake")
  )
    return new FakeMessagingProvider(input.fakeMode ?? "success");
  throw new ProviderError(
    "PROVIDER_UNAVAILABLE",
    false,
    "Messaging provider adapter is not available",
  );
}
