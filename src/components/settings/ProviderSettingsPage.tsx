import { useMemo } from "react";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSettings } from "@/hooks/useSettings";
import { useRouter } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Info,
  Sparkles,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ModelsSection } from "./ModelsSection";
import { ApiKeyConfiguration } from "./ApiKeyConfiguration";
import { GoogleConfiguration } from "./GoogleConfiguration";
import { OpenAIConfiguration } from "./OpenAIConfiguration";
import { AzureConfiguration } from "./AzureConfiguration";
import { VertexConfiguration } from "./VertexConfiguration";
import { showError } from "@/lib/toast";
import { IpcClient } from "@/ipc/ipc_client";
import type { UserSettings } from "@/lib/schemas";

interface ProviderSettingsPageProps {
  provider: string;
}

export function ProviderSettingsPage({ provider }: ProviderSettingsPageProps) {
  const router = useRouter();
  const {
    settings,
    envVars,
    loading: settingsLoading,
    updateSettings,
  } = useSettings();

  const {
    data: providers,
    isLoading: providersLoading,
    error: providersError,
  } = useLanguageModelProviders();

  const isDyad = provider === "auto";
  const providerData = providers?.find((p) => p.id === provider);

  const providerDisplayName = isDyad
    ? "Dyad"
    : providerData?.name ?? provider.toUpperCase();

  const providerWebsiteUrl = isDyad
    ? "https://academy.dyad.sh/settings"
    : providerData?.websiteUrl;

  const showModelsSection =
    providerData?.type === "cloud" ||
    providerData?.type === "custom" ||
    provider === "auto";

  const handleToggleDyadPro = async (enabled: boolean) => {
    try {
      const updates: Partial<UserSettings> = { enableDyadPro: enabled };
      if (enabled) {
        updates.enableProSmartFilesContextMode = true;
        updates.enableProLazyEditsMode = true;
        if (!settings?.proSmartContextOption) {
          updates.proSmartContextOption = "balanced";
        }
      }
      await updateSettings(updates);
    } catch (error: any) {
      showError(`Error toggling Dyad Pro: ${error}`);
    }
  };

  const configuration = useMemo(() => {
    if (isDyad) {
      return (
        <div className="mt-6 flex items-center justify-between p-4 border rounded-lg bg-(--background-lightest)">
          <div>
            <h3 className="font-medium flex items-center gap-2">
              Enable Dyad Pro
              <Badge variant="outline" className="uppercase tracking-wide">
                <Sparkles className="h-3 w-3 mr-1" />
                Pro
              </Badge>
            </h3>
            <p className="text-sm text-muted-foreground">
              Unlock Dyad Pro features such as smart context, lazy edits, and
              web search.
            </p>
          </div>
          <Switch
            checked={settings?.enableDyadPro}
            onCheckedChange={handleToggleDyadPro}
          />
        </div>
      );
    }

    if (!providerData) {
      return (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Provider not found</AlertTitle>
          <AlertDescription>
            The provider with ID "{provider}" could not be found.
          </AlertDescription>
        </Alert>
      );
    }

    switch (provider) {
      case "openai":
        return (
          <OpenAIConfiguration
            settings={settings}
            envVars={envVars}
            updateSettings={updateSettings}
          />
        );
      case "google":
        return (
          <GoogleConfiguration
            settings={settings}
            envVars={envVars}
            updateSettings={updateSettings}
          />
        );
      case "azure":
        return (
          <AzureConfiguration
            settings={settings}
            envVars={envVars}
            updateSettings={updateSettings}
          />
        );
      case "vertex":
        return <VertexConfiguration />;
      default:
        if (providerData.type === "custom") {
          return (
            <Alert variant="default">
              <Info className="h-4 w-4" />
              <AlertTitle>Custom provider configuration</AlertTitle>
              <AlertDescription>
                Manage credentials for this provider via the edit dialog in the
                provider list.
              </AlertDescription>
            </Alert>
          );
        }

        return (
          <ApiKeyConfiguration
            providerId={provider}
            providerName={providerDisplayName}
            settings={settings}
            envVars={envVars}
            envVarName={providerData.envVarName}
            updateSettings={updateSettings}
          />
        );
    }
  }, [
    envVars,
    isDyad,
    provider,
    providerData,
    providerDisplayName,
    settings,
    updateSettings,
  ]);

  if (providersLoading) {
    return (
      <div className="min-h-screen px-8 py-4">
        <div className="max-w-4xl mx-auto space-y-6">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (providersError) {
    return (
      <div className="min-h-screen px-8 py-4">
        <div className="max-w-4xl mx-auto space-y-4">
          <Button
            onClick={() => router.history.back()}
            variant="outline"
            size="sm"
            className="flex items-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Go Back
          </Button>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error loading provider details</AlertTitle>
            <AlertDescription>
              Could not load provider data: {providersError.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-8 py-4">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <Button
            onClick={() => router.history.back()}
            variant="ghost"
            size="sm"
            className="flex items-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Providers
          </Button>
          {providerWebsiteUrl && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                IpcClient.getInstance().openExternalUrl(providerWebsiteUrl)
              }
              className="flex items-center gap-2"
            >
              Docs
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {providerDisplayName}
          </h1>
          {providerData?.hasFreeTier && (
            <Badge variant="secondary" className="mt-2">
              Free tier available
            </Badge>
          )}
        </div>

        {settingsLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          configuration
        )}

        {showModelsSection && <ModelsSection providerId={provider} />}
      </div>
    </div>
  );
}
