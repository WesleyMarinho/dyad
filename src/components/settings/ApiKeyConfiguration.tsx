import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, Info } from "lucide-react";
import type { UserSettings } from "@/lib/schemas";

interface ApiKeyConfigurationProps {
  providerId: string;
  providerName: string;
  settings: UserSettings | null | undefined;
  envVars: Record<string, string | undefined>;
  envVarName?: string;
  updateSettings: (settings: Partial<UserSettings>) => Promise<UserSettings>;
}

export function ApiKeyConfiguration({
  providerId,
  providerName,
  settings,
  envVars,
  envVarName,
  updateSettings,
}: ApiKeyConfigurationProps) {
  const existing = settings?.providerSettings?.[providerId] as
    | { apiKey?: { value: string } }
    | undefined;
  const existingValue = existing?.apiKey?.value ?? "";

  const [apiKey, setApiKey] = useState(existingValue);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setApiKey(existingValue);
  }, [existingValue]);

  const envValue = envVarName ? envVars[envVarName] : undefined;

  const hasSavedKey = Boolean(existingValue);
  const usingEnvOnly = Boolean(envValue && !existingValue);

  const hasUnsavedChanges = useMemo(() => apiKey !== existingValue, [
    apiKey,
    existingValue,
  ]);

  const status = useMemo(() => {
    if (hasSavedKey) {
      return {
        variant: "default" as const,
        title: `${providerName} API key saved`,
        description: "Dyad will use the API key stored in settings.",
        icon: CheckCircle2,
      };
    }
    if (usingEnvOnly) {
      return {
        variant: "default" as const,
        title: "Using environment variable",
        description: envVarName
          ? `${envVarName} is set. Saving a key here will override the environment variable.`
          : "An environment variable is providing the API key for this provider.",
        icon: Info,
      };
    }
    return {
      variant: "destructive" as const,
      title: "API key required",
      description: envVarName
        ? `Provide an API key below or configure the ${envVarName} environment variable.`
        : "Provide an API key below to enable this provider.",
      icon: Info,
    };
  }, [hasSavedKey, usingEnvOnly, envVarName, providerName]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const trimmed = apiKey.trim();
      const providerSettings = {
        ...settings?.providerSettings,
        [providerId]: trimmed
          ? {
              ...(settings?.providerSettings?.[providerId] ?? {}),
              apiKey: { value: trimmed },
            }
          : {
              ...(settings?.providerSettings?.[providerId] ?? {}),
            },
      };

      if (!trimmed) {
        delete providerSettings[providerId].apiKey;
      }

      await updateSettings({ providerSettings });
      setSaved(true);
    } catch (e: any) {
      setError(e?.message || "Failed to save API key");
    } finally {
      setSaving(false);
    }
  };

  const StatusIcon = status.icon;

  return (
    <div className="space-y-4">
      <Alert variant={status.variant}>
        <StatusIcon className="h-4 w-4" />
        <AlertTitle>{status.title}</AlertTitle>
        <AlertDescription>{status.description}</AlertDescription>
      </Alert>

      <div className="space-y-2">
        <label
          htmlFor={`${providerId}-api-key`}
          className="block text-sm font-medium"
        >
          {providerName} API Key
        </label>
        <Input
          id={`${providerId}-api-key`}
          type="password"
          placeholder={`Enter your ${providerName} API key`}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setSaved(false);
            setError(null);
          }}
          autoComplete="off"
        />
        {envVarName && (
          <p className="text-xs text-muted-foreground">
            Environment variable: <code>{envVarName}</code>
            {envValue ? " (currently set)" : " (not set)"}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          onClick={handleSave}
          disabled={saving || !hasUnsavedChanges}
          type="button"
        >
          {saving ? "Saving..." : "Save Settings"}
        </Button>
        {saved && !error && (
          <span className="flex items-center text-green-600 text-sm">
            <CheckCircle2 className="h-4 w-4 mr-1" /> Saved
          </span>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Save Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
