import { useQuery } from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";
import type { LanguageModelProvider } from "@/ipc/ipc_types";
import { useSettings } from "./useSettings";
import {
  cloudProviders,
  VertexProviderSetting,
  AzureProviderSetting,
  GoogleProviderSetting,
  OpenAIProviderSetting,
} from "@/lib/schemas";

export function useLanguageModelProviders() {
  const ipcClient = IpcClient.getInstance();
  const { settings, envVars } = useSettings();

  const queryResult = useQuery<LanguageModelProvider[], Error>({
    queryKey: ["languageModelProviders"],
    queryFn: async () => {
      return ipcClient.getLanguageModelProviders();
    },
  });

  const isProviderSetup = (provider: string) => {
    const providerSettings = settings?.providerSettings[provider];
    if (queryResult.isLoading) {
      return false;
    }

    if (provider === "google") {
      const googleSettings = providerSettings as
        | GoogleProviderSetting
        | undefined;
      const connectionMode = googleSettings?.connectionMode ?? "api";

      if (connectionMode !== "api") {
        const hasExplicitPath = Boolean(
          googleSettings?.cliPath && googleSettings.cliPath.trim(),
        );
        const hasEnvPath = Boolean(envVars["GEMINI_CLI_PATH"]);

        if (
          hasExplicitPath ||
          hasEnvPath ||
          googleSettings?.cliAutoDetect !== false
        ) {
          return true;
        }
      }
    }

    if (provider === "openai" || provider === "codex") {
      const openAiSettings = (provider === "codex"
        ? (settings?.providerSettings?.openai as
            | OpenAIProviderSetting
            | undefined)
        : (providerSettings as OpenAIProviderSetting | undefined)) ??
        undefined;
      const connectionMode = openAiSettings?.connectionMode ?? "api";

      if (connectionMode !== "api") {
        const hasExplicitPath = Boolean(
          openAiSettings?.cliPath && openAiSettings.cliPath.trim(),
        );
        const hasEnvPath = Boolean(envVars["CODEX_CLI_PATH"]);

        if (
          hasExplicitPath ||
          hasEnvPath ||
          openAiSettings?.cliAutoDetect !== false
        ) {
          return true;
        }
      }
    }

    // Vertex uses service account credentials instead of an API key
    if (provider === "vertex") {
      const vertexSettings = providerSettings as VertexProviderSetting;
      if (
        vertexSettings?.serviceAccountKey?.value &&
        vertexSettings?.projectId &&
        vertexSettings?.location
      ) {
        return true;
      }
      return false;
    }
    if (provider === "azure") {
      const azureSettings = providerSettings as AzureProviderSetting;
      const hasSavedSettings = Boolean(
        (azureSettings?.apiKey?.value ?? "").trim() &&
          (azureSettings?.resourceName ?? "").trim(),
      );
      if (hasSavedSettings) {
        return true;
      }
      if (envVars["AZURE_API_KEY"] && envVars["AZURE_RESOURCE_NAME"]) {
        return true;
      }
      return false;
    }
    if (providerSettings?.apiKey?.value) {
      return true;
    }
    const providerData = queryResult.data?.find((p) => p.id === provider);
    if (providerData?.envVarName && envVars[providerData.envVarName]) {
      return true;
    }
    return false;
  };

  const isAnyProviderSetup = () => {
    // Check all available providers, not just cloud providers
    // This includes custom providers added by the user
    if (!queryResult.data) {
      return false;
    }
    return queryResult.data.some((provider) => isProviderSetup(provider.id));
  };

  return {
    ...queryResult,
    isProviderSetup,
    isAnyProviderSetup,
  };
}
