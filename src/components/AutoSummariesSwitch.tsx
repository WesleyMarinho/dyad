import { useSettings } from "@/hooks/useSettings";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function AutoSummariesSwitch() {
  const { settings, updateSettings } = useSettings();

  return (
    <div className="flex items-center space-x-2">
      <Switch
        id="auto-summarize"
        checked={!!settings?.enableAutoSummaries}
        onCheckedChange={(checked) => {
          updateSettings({ enableAutoSummaries: checked });
        }}
      />
      <Label htmlFor="auto-summarize">Auto-summarize long chats</Label>
    </div>
  );
}
