import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI as createGoogle } from "@ai-sdk/google";
import { createVertex as createGoogleVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LanguageModelV2 } from "@ai-sdk/provider";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type {
  AzureProviderSetting,
  LargeLanguageModel,
  UserSettings,
  VertexProviderSetting,
  GoogleProviderSetting,
  OpenAIProviderSetting,
} from "../../lib/schemas";
import { LanguageModelProvider } from "../ipc_types";
import { FREE_OPENROUTER_MODEL_NAMES } from "../shared/language_model_constants";
import { getLanguageModelProviders } from "../shared/language_model_helpers";
import { createDyadEngine } from "./llm_engine_provider";
import { getEnvVar } from "./read_env";
import log from "electron-log";

import { getOllamaApiUrl } from "../handlers/local_model_ollama_handler";
import { createFallback } from "./fallback_ai_model";
import { LM_STUDIO_BASE_URL } from "./lm_studio_utils";
import { createOllamaProvider } from "./ollama_provider";
import {
  createCodexCliModel,
  ensureCodexCliAvailable,
} from "./codex_cli_provider";
import {
  createGeminiCliModel,
  ensureGeminiCliAvailable,
} from "./gemini_cli_provider";

const dyadEngineUrl = process.env.DYAD_ENGINE_URL;
const dyadGatewayUrl = process.env.DYAD_GATEWAY_URL;

const logger = log.scope("getModelClient");

const AUTO_MODELS = [
  {
    provider: "google",
    name: "gemini-2.5-flash",
  },
  {
    provider: "openrouter",
    name: "qwen/qwen3-coder:free",
  },
  {
    provider: "anthropic",
    name: "claude-sonnet-4-20250514",
  },
  {
    provider: "openai",
    name: "gpt-4.1",
  },
];

export interface ModelClient {
  model: LanguageModelV2;
  builtinProviderId?: string;
}

interface File {
  path: string;
  content: string;
}

export async function getModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  files?: File[],
): Promise<{
  modelClient: ModelClient;
  isEngineEnabled?: boolean;
}> {
  const allProviders = await getLanguageModelProviders();

  const dyadApiKey = (settings.providerSettings?.auto as any)?.apiKey?.value;

  // --- Handle specific provider ---
  const providerConfig = allProviders.find((p) => p.id === model.provider);

  if (!providerConfig) {
    throw new Error(`Configuration not found for provider: ${model.provider}`);
  }

  // Handle Dyad Pro override
  if (dyadApiKey && settings.enableDyadPro) {
    // Check if the selected provider supports Dyad Pro (has a gateway prefix) OR
    // we're using local engine.
    // IMPORTANT: some providers like OpenAI have an empty string gateway prefix,
    // so we do a nullish and not a truthy check here.
    if (providerConfig.gatewayPrefix != null || dyadEngineUrl) {
      const isEngineEnabled =
        settings.enableProSmartFilesContextMode ||
        settings.enableProLazyEditsMode ||
        settings.enableProWebSearch;
      const provider = isEngineEnabled
        ? createDyadEngine({
            apiKey: dyadApiKey,
            baseURL: dyadEngineUrl ?? "https://engine.dyad.sh/v1",
            originalProviderId: model.provider,
            dyadOptions: {
              enableLazyEdits:
                settings.selectedChatMode === "ask"
                  ? false
                  : settings.enableProLazyEditsMode,
              enableSmartFilesContext: settings.enableProSmartFilesContextMode,
              // Keep in sync with getCurrentValue in ProModeSelector.tsx
              smartContextMode: settings.proSmartContextOption ?? "balanced",
              enableWebSearch: settings.enableProWebSearch,
            },
            settings,
          })
        : createOpenAICompatible({
            name: "dyad-gateway",
            apiKey: dyadApiKey,
            baseURL: dyadGatewayUrl ?? "https://llm-gateway.dyad.sh/v1",
          });

      if (isEngineEnabled) {
      } else {
      }
      // Do not use free variant (for openrouter).
      const modelName = model.name.split(":free")[0];
      const autoModelClient = {
        model: provider(
          `${providerConfig.gatewayPrefix || ""}${modelName}`,
          isEngineEnabled
            ? {
                files,
              }
            : undefined,
        ),
        builtinProviderId: model.provider,
      };

      return {
        modelClient: autoModelClient,
        isEngineEnabled,
      };
    } else {
      // Fall through to regular provider logic if gateway prefix is missing
    }
  }
  // Handle 'auto' provider by trying each model in AUTO_MODELS until one works
  if (model.provider === "auto") {
    if (model.name === "free") {
      const openRouterProvider = allProviders.find(
        (p) => p.id === "openrouter",
      );
      if (!openRouterProvider) {
        throw new Error("OpenRouter provider not found");
      }
      return {
        modelClient: {
          model: createFallback({
            models: await Promise.all(
              FREE_OPENROUTER_MODEL_NAMES.map(
                async (name: string) =>
                  (await getRegularModelClient(
                    { provider: "openrouter", name },
                    settings,
                    openRouterProvider,
                  )).modelClient.model,
              )
            ),
          }),
          builtinProviderId: "openrouter",
        },
        isEngineEnabled: false,
      };
    }
    for (const autoModel of AUTO_MODELS) {
      const providerInfo = allProviders.find(
        (p) => p.id === autoModel.provider,
      );
      const envVarName = providerInfo?.envVarName;

      const apiKey =
        (settings.providerSettings?.[autoModel.provider] as any)?.apiKey?.value ||
        (envVarName ? getEnvVar(envVarName) : undefined);

      if (apiKey) {
        // Recursively call with the specific model found
        return await getModelClient(
          {
            provider: autoModel.provider,
            name: autoModel.name,
          },
          settings,
          files,
        );
      }
    }
    // If no models have API keys, throw an error
    throw new Error(
      "No API keys available for any model supported by the 'auto' provider.",
    );
  }
  return await getRegularModelClient(model, settings, providerConfig);
}

async function getRegularModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  providerConfig: LanguageModelProvider,
): Promise<{
  modelClient: ModelClient;
  backupModelClients: ModelClient[];
}> {
  // Get API key for the specific provider
  const apiKey =
    (settings.providerSettings?.[model.provider] as any)?.apiKey?.value ||
    (providerConfig.envVarName
      ? getEnvVar(providerConfig.envVarName)
      : undefined);

  const providerId = providerConfig.id;
  // Create client based on provider ID or type
  switch (providerId) {
    case "anthropic": {
      const provider = createAnthropic({ apiKey });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "xai": {
      const provider = createXai({ apiKey });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "google": {
      const googleSettings = settings.providerSettings?.google as
        | GoogleProviderSetting
        | undefined;

      const connectionMode = googleSettings?.connectionMode ?? "api";
      const cliFallbackToApi = googleSettings?.cliFallbackToApi ?? true;
      const cliPreferredModels = googleSettings?.cliPreferredModels;
      const cliTimeoutMs = googleSettings?.cliTimeoutMs;
      const cliAutoDetect = googleSettings?.cliAutoDetect ?? true;

      // Attempt CLI mode if requested.
      if (connectionMode !== "api") {
        try {
          const cliInfo = await ensureGeminiCliAvailable({
            explicitPath: googleSettings?.cliPath,
            autoDetect: cliAutoDetect,
          });

          if (!cliInfo.path) {
            throw new Error("Gemini CLI path could not be resolved.");
          }

          const cliModelId = selectCliModel(model.name, cliPreferredModels);

          const cliModel = await createGeminiCliModel(cliModelId, {
            cliPath: cliInfo.path,
            timeoutMs: cliTimeoutMs,
          });

          return {
            modelClient: {
              model: cliModel,
              builtinProviderId: providerId,
            },
            backupModelClients: [],
          };
        } catch (error) {
          logger.warn(
            "Gemini CLI unavailable or failed, evaluating API fallback",
            error,
          );

          const allowFallback =
            connectionMode === "auto" || cliFallbackToApi === true;

          if (!allowFallback) {
            throw new Error(
              error instanceof Error
                ? error.message
                : JSON.stringify(error ?? "Gemini CLI failed"),
            );
          }

          if (!apiKey) {
            throw new Error(
              "Gemini CLI is unavailable and no Gemini API key is configured for fallback. Provide an API key or fix the CLI configuration.",
            );
          }
        }
      }

      if (!apiKey) {
        throw new Error(
          "Gemini API key is not configured. Provide it in Settings or set GEMINI_API_KEY.",
        );
      }

      const provider = createGoogle({ apiKey });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "openai": {
      const openAiSettings = settings.providerSettings?.openai as
        | OpenAIProviderSetting
        | undefined;

      const connectionMode = openAiSettings?.connectionMode ?? "api";
      const cliFallbackToApi = openAiSettings?.cliFallbackToApi ?? true;
      const cliPreferredModels = openAiSettings?.cliPreferredModels;
      const cliTimeoutMs = openAiSettings?.cliTimeoutMs;
      const cliAutoDetect = openAiSettings?.cliAutoDetect ?? true;

      if (connectionMode !== "api") {
        try {
          const cliInfo = await ensureCodexCliAvailable({
            explicitPath: openAiSettings?.cliPath,
            autoDetect: cliAutoDetect,
          });

          if (!cliInfo.path) {
            throw new Error("Codex CLI path could not be resolved.");
          }

          const cliModelId = selectCliModel(model.name, cliPreferredModels);

          const cliModel = await createCodexCliModel(cliModelId, {
            cliPath: cliInfo.path,
            timeoutMs: cliTimeoutMs,
            apiKey,
          });

          return {
            modelClient: {
              model: cliModel,
              builtinProviderId: providerId,
            },
            backupModelClients: [],
          };
        } catch (error) {
          logger.warn(
            "Codex CLI unavailable or failed, evaluating API fallback",
            error,
          );

          const allowFallback =
            connectionMode === "auto" || cliFallbackToApi === true;

          if (!allowFallback) {
            throw new Error(
              error instanceof Error
                ? error.message
                : JSON.stringify(error ?? "Codex CLI failed"),
            );
          }

          if (!apiKey) {
            throw new Error(
              "Codex CLI is unavailable and no OpenAI API key is configured for fallback. Provide an API key or fix the CLI configuration.",
            );
          }
        }
      }

      const shouldUseApiFallback =
        connectionMode === "api" ||
        connectionMode === "auto" ||
        cliFallbackToApi === true;

      if (!shouldUseApiFallback) {
        throw new Error(
          "Codex CLI is not available and API fallback is disabled. Install the Codex CLI or enable fallback to continue.",
        );
      }

      if (!apiKey) {
        throw new Error(
          "OpenAI API key is required when using API mode or fallback. Provide it in Settings or set OPENAI_API_KEY.",
        );
      }

      const provider = createOpenAI({ apiKey });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "vertex": {
      // Vertex uses Google service account credentials with project/location
      const vertexSettings = settings.providerSettings?.[
        model.provider
      ] as VertexProviderSetting;
      const project = vertexSettings?.projectId;
      const location = vertexSettings?.location;
      const serviceAccountKey = vertexSettings?.serviceAccountKey?.value;

      // Use a baseURL that does NOT pin to publishers/google so that
      // full publisher model IDs (e.g. publishers/deepseek-ai/models/...) work.
      const regionHost = `${location === "global" ? "" : `${location}-`}aiplatform.googleapis.com`;
      const baseURL = `https://${regionHost}/v1/projects/${project}/locations/${location}`;
      const provider = createGoogleVertex({
        project,
        location,
        baseURL,
        googleAuthOptions: serviceAccountKey
          ? {
              // Expecting the user to paste the full JSON of the service account key
              credentials: JSON.parse(serviceAccountKey),
            }
          : undefined,
      });
      return {
        modelClient: {
          // For built-in Google models on Vertex, the path must include
          // publishers/google/models/<model>. For partner MaaS models the
          // full publisher path is already included.
          model: provider(
            model.name.includes("/")
              ? model.name
              : `publishers/google/models/${model.name}`,
          ),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "openrouter": {
      const provider = createOpenRouter({ apiKey });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "azure": {
      const azureSettings = settings.providerSettings?.azure as
        | AzureProviderSetting
        | undefined;
      const azureApiKeyFromSettings = (
        azureSettings?.apiKey?.value ?? ""
      ).trim();
      const azureResourceNameFromSettings = (
        azureSettings?.resourceName ?? ""
      ).trim();
      const envResourceName = (getEnvVar("AZURE_RESOURCE_NAME") ?? "").trim();
      const envAzureApiKey = (getEnvVar("AZURE_API_KEY") ?? "").trim();

      const resourceName = azureResourceNameFromSettings || envResourceName;
      const azureApiKey = azureApiKeyFromSettings || envAzureApiKey;

      if (!resourceName) {
        throw new Error(
          "Azure OpenAI resource name is required. Provide it in Settings or set the AZURE_RESOURCE_NAME environment variable.",
        );
      }

      if (!azureApiKey) {
        throw new Error(
          "Azure OpenAI API key is required. Provide it in Settings or set the AZURE_API_KEY environment variable.",
        );
      }

      const provider = createAzure({
        resourceName,
        apiKey: azureApiKey,
      });

      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "ollama": {
      const provider = createOllamaProvider({ baseURL: getOllamaApiUrl() });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "lmstudio": {
      // LM Studio uses OpenAI compatible API
      const baseURL = providerConfig.apiBaseUrl || LM_STUDIO_BASE_URL + "/v1";
      const provider = createOpenAICompatible({
        name: "lmstudio",
        baseURL,
      });
      return {
        modelClient: {
          model: provider(model.name),
        },
        backupModelClients: [],
      };
    }
    case "bedrock": {
      // AWS Bedrock supports API key authentication using AWS_BEARER_TOKEN_BEDROCK
      // See: https://sdk.vercel.ai/providers/ai-sdk-providers/amazon-bedrock#api-key-authentication
      const provider = createAmazonBedrock({
        apiKey: apiKey,
        region: getEnvVar("AWS_REGION") || "us-east-1",
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    default: {
      // Handle custom providers
      if (providerConfig.type === "custom") {
        if (!providerConfig.apiBaseUrl) {
          throw new Error(
            `Custom provider ${model.provider} is missing the API Base URL.`,
          );
        }
        // Assume custom providers are OpenAI compatible for now
        const provider = createOpenAICompatible({
          name: providerConfig.id,
          baseURL: providerConfig.apiBaseUrl,
          apiKey,
        });
        return {
          modelClient: {
            model: provider(model.name),
          },
          backupModelClients: [],
        };
      }
      // If it's not a known ID and not type 'custom', it's unsupported
      throw new Error(`Unsupported model provider: ${model.provider}`);
    }
  }
}

function selectCliModel(
  requestedModel: string,
  preferredModels: string[] | undefined,
) {
  if (preferredModels && preferredModels.length > 0) {
    if (preferredModels.includes(requestedModel)) {
      return requestedModel;
    }
    return preferredModels[0];
  }
  return requestedModel;
}
