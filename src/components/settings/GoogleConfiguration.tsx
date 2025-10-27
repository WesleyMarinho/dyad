import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Info, RefreshCcw } from "lucide-react";
import type { GoogleProviderSetting, UserSettings } from "@/lib/schemas";
import { IpcClient } from "@/ipc/ipc_client";
import type { GeminiCliInfo } from "@/ipc/utils/gemini_cli_detector";

const DEFAULT_CLI_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"];

interface GoogleConfigurationProps {
  settings: UserSettings | null | undefined;
  envVars: Record<string, string | undefined>;
  updateSettings: (settings: Partial<UserSettings>) => Promise<UserSettings>;
}

export function GoogleConfiguration({
  settings,
  envVars,
  updateSettings,
}: GoogleConfigurationProps) {
  const existing =
    (settings?.providerSettings?.google as GoogleProviderSetting) ?? undefined;

  const [apiKey, setApiKey] = useState(existing?.apiKey?.value ?? "");
  const [connectionMode, setConnectionMode] = useState<
    GoogleProviderSetting["connectionMode"]
  >(existing?.connectionMode ?? "api");
  const [cliPath, setCliPath] = useState(existing?.cliPath ?? "");
  const [cliAutoDetect, setCliAutoDetect] = useState(
    existing?.cliAutoDetect ?? true,
  );
  const [cliFallbackToApi, setCliFallbackToApi] = useState(
    existing?.cliFallbackToApi ?? true,
  );
  const [cliPreferredModels, setCliPreferredModels] = useState(
    (existing?.cliPreferredModels ?? DEFAULT_CLI_MODELS).join(", "),
  );
  const [cliTimeoutMs, setCliTimeoutMs] = useState(
    existing?.cliTimeoutMs?.toString() ?? "60000",
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [detectionResult, setDetectionResult] = useState<
    GeminiCliInfo | null
  >(null);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    setApiKey(existing?.apiKey?.value ?? "");
    setConnectionMode(existing?.connectionMode ?? "api");
    setCliPath(existing?.cliPath ?? "");
    setCliAutoDetect(existing?.cliAutoDetect ?? true);
    setCliFallbackToApi(existing?.cliFallbackToApi ?? true);
    setCliPreferredModels(
      (existing?.cliPreferredModels ?? DEFAULT_CLI_MODELS).join(", "),
    );
    setCliTimeoutMs(existing?.cliTimeoutMs?.toString() ?? "60000");
  }, [existing?.apiKey?.value, existing?.connectionMode, existing?.cliPath]);

  const envApiKey = envVars["GEMINI_API_KEY"];
  const envCliPath = envVars["GEMINI_CLI_PATH"];

  const hasSavedApiKey = Boolean(existing?.apiKey?.value);
  const apiStatus = useMemo(() => {
    if (hasSavedApiKey) {
      return {
        variant: "default" as const,
        title: "Gemini API key saved",
        description:
          "Dyad will use the API key saved in settings when using Google models.",
        icon: CheckCircle2,
      };
    }
    if (envApiKey) {
      return {
        variant: "default" as const,
        title: "Using environment variable",
        description:
          "GEMINI_API_KEY is set. Values saved below will override the environment variable.",
        icon: Info,
      };
    }
    return {
      variant: "destructive" as const,
      title: "API key recommended",
      description:
        "Provide an API key to enable API mode or fallback from CLI when necessary.",
      icon: Info,
    };
  }, [hasSavedApiKey, envApiKey]);

  const hasUnsavedChanges = useMemo(() => {
    const preferredModelsNormalized = cliPreferredModels
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .join(",");
    const existingModelsNormalized = (
      existing?.cliPreferredModels ?? DEFAULT_CLI_MODELS
    )
      .map((m) => m.trim())
      .filter(Boolean)
      .join(",");

    return (
      apiKey !== (existing?.apiKey?.value ?? "") ||
      connectionMode !== (existing?.connectionMode ?? "api") ||
      cliPath !== (existing?.cliPath ?? "") ||
      cliAutoDetect !== (existing?.cliAutoDetect ?? true) ||
      cliFallbackToApi !== (existing?.cliFallbackToApi ?? true) ||
      preferredModelsNormalized !== existingModelsNormalized ||
      cliTimeoutMs !== (existing?.cliTimeoutMs ?? 60000).toString()
    );
  }, [
    apiKey,
    existing?.apiKey?.value,
    connectionMode,
    existing?.connectionMode,
    cliPath,
    existing?.cliPath,
    cliAutoDetect,
    existing?.cliAutoDetect,
    cliFallbackToApi,
    existing?.cliFallbackToApi,
    cliPreferredModels,
    existing?.cliPreferredModels,
    cliTimeoutMs,
    existing?.cliTimeoutMs,
  ]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const trimmedApiKey = apiKey.trim();
      const trimmedPath = cliPath.trim();
      const parsedTimeout = parseInt(cliTimeoutMs, 10);

      const normalizedPreferredModels = cliPreferredModels
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean);

      const googleSettings: GoogleProviderSetting = {
        ...(existing ?? {}),
        connectionMode,
        cliPath: trimmedPath || undefined,
        cliAutoDetect,
        cliFallbackToApi,
        cliPreferredModels:
          normalizedPreferredModels.length > 0
            ? normalizedPreferredModels
            : DEFAULT_CLI_MODELS,
        cliTimeoutMs:
          Number.isFinite(parsedTimeout) && parsedTimeout > 0
            ? parsedTimeout
            : 60000,
      };

      if (trimmedApiKey) {
        googleSettings.apiKey = { value: trimmedApiKey };
      } else if (googleSettings.apiKey) {
        delete googleSettings.apiKey;
      }

      const providerSettings = {
        ...settings?.providerSettings,
        google: googleSettings,
      };

      await updateSettings({ providerSettings });
      setSaved(true);
    } catch (e: any) {
      setError(e?.message || "Failed to save Google settings");
    } finally {
      setSaving(false);
    }
  };

  const handleDetect = async () => {
    setDetecting(true);
    setError(null);
    try {
      const result = await IpcClient.getInstance().detectGeminiCli({
        explicitPath: cliPath.trim() || undefined,
        autoDetect: cliAutoDetect,
      });
      setDetectionResult(result);
    } catch (e: any) {
      setDetectionResult({
        path: null,
        isAvailable: false,
        authStatus: "unknown",
        errorMessage: e?.message ?? "Failed to check Gemini CLI",
      });
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    if (connectionMode === "api") {
      setDetectionResult(null);
      return;
    }
    // Automatically run detection once when entering CLI/auto mode
    void handleDetect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionMode]);

  const detectionStatus = useMemo(() => {
    if (connectionMode === "api") {
      return null;
    }
    if (!detectionResult) {
      return (
        <Alert variant="default">
          <Info className="h-4 w-4" />
          <AlertTitle>CLI detection pending</AlertTitle>
          <AlertDescription>
            Run the CLI check to confirm availability.
          </AlertDescription>
        </Alert>
      );
    }
    if (detectionResult.isAvailable && detectionResult.path) {
      return (
        <Alert variant="default">
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <AlertTitle>Gemini CLI detected</AlertTitle>
          <AlertDescription className="space-y-1">
            <div>Path: {detectionResult.path}</div>
            {detectionResult.version && (
              <div>
                Version:{" "}
                <Badge variant="outline">{detectionResult.version}</Badge>
              </div>
            )}
            {detectionResult.authStatus === "error" &&
              detectionResult.errorMessage && (
                <div className="text-amber-600 text-xs">
                  {detectionResult.errorMessage}
                </div>
              )}
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert variant="destructive">
        <AlertTitle>Gemini CLI not available</AlertTitle>
        <AlertDescription>
          {detectionResult.errorMessage ||
            "Dyad could not find the Gemini CLI. Check your installation or specify the executable path."}
        </AlertDescription>
      </Alert>
    );
  }, [detectionResult, connectionMode]);

  const StatusIcon = apiStatus.icon;

  return (
    <div className="space-y-6">
      <Alert variant={apiStatus.variant}>
        <StatusIcon className="h-4 w-4" />
        <AlertTitle>{apiStatus.title}</AlertTitle>
        <AlertDescription>{apiStatus.description}</AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label className="block text-sm font-medium">Connection Mode</label>
          <Select
            value={connectionMode}
            onValueChange={(value) =>
              setConnectionMode(value as GoogleProviderSetting["connectionMode"])
            }
          >
            <SelectTrigger className="w-full md:w-64">
              <SelectValue placeholder="Select mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="api">API only</SelectItem>
              <SelectItem value="cli">Gemini CLI only</SelectItem>
              <SelectItem value="auto">Auto (CLI with API fallback)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Choose how Dyad connects to Gemini. Auto mode prefers CLI but falls
            back to the API when needed.
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium">API Key</label>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setSaved(false);
              setError(null);
            }}
            placeholder="Enter your Gemini API key"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Environment variable: <code>GEMINI_API_KEY</code>{" "}
            {envApiKey ? "(set)" : "(not set)"}
          </p>
        </div>
      </div>

      {connectionMode !== "api" && (
        <div className="space-y-4 border border-border rounded-lg p-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h3 className="font-medium">Gemini CLI Settings</h3>
              <p className="text-xs text-muted-foreground">
                Configure CLI detection and fallback options.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleDetect}
              disabled={detecting}
            >
              <RefreshCcw className="h-4 w-4 mr-2" />
              {detecting ? "Checking..." : "Check CLI"}
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                CLI Executable Path
              </label>
              <Input
                value={cliPath}
                onChange={(event) => {
                  setCliPath(event.target.value);
                  setSaved(false);
                  setError(null);
                }}
                placeholder="Optional: /usr/local/bin/gemini"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Environment variable: <code>GEMINI_CLI_PATH</code>{" "}
                {envCliPath ? "(set)" : "(not set)"}
              </p>
            </div>

            <div className="flex items-center justify-between border border-dashed rounded-md px-3 py-2">
              <div>
                <p className="text-sm font-medium">Auto-detect CLI</p>
                <p className="text-xs text-muted-foreground">
                  Search common locations and PATH for the executable.
                </p>
              </div>
              <Switch
                checked={cliAutoDetect}
                onCheckedChange={(checked) => {
                  setCliAutoDetect(checked);
                  setSaved(false);
                }}
              />
            </div>

            <div className="flex items-center justify-between border border-dashed rounded-md px-3 py-2">
              <div>
                <p className="text-sm font-medium">Allow API fallback</p>
                <p className="text-xs text-muted-foreground">
                  When CLI fails, automatically retry with the API.
                </p>
              </div>
              <Switch
                checked={cliFallbackToApi}
                onCheckedChange={(checked) => {
                  setCliFallbackToApi(checked);
                  setSaved(false);
                }}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Preferred CLI models (comma separated)
              </label>
              <Textarea
                value={cliPreferredModels}
                onChange={(event) => {
                  setCliPreferredModels(event.target.value);
                  setSaved(false);
                  setError(null);
                }}
                placeholder="gemini-2.5-pro, gemini-2.5-flash"
                className="min-h-20"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">
                CLI timeout (ms)
              </label>
              <Input
                type="number"
                value={cliTimeoutMs}
                min={1000}
                step={1000}
                onChange={(event) => {
                  setCliTimeoutMs(event.target.value);
                  setSaved(false);
                }}
              />
            </div>
          </div>

          {detectionStatus}
        </div>
      )}

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
