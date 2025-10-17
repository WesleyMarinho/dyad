import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IpcClient } from "@/ipc/ipc_client";
import { showSuccess } from "@/lib/toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, Smartphone, TabletSmartphone } from "lucide-react";
import { useState } from "react";

export function ExpoControls({ appId }: { appId: number }) {
    const [androidOpening, setAndroidOpening] = useState(false);
    const [iosOpening, setIosOpening] = useState(false);

    const { data: isExpo, isLoading } = useQuery({
        queryKey: ["is-expo", appId],
        queryFn: () => IpcClient.getInstance().isExpo({ appId }),
        enabled: !!appId,
    });

    const openAndroid = useMutation({
        mutationFn: async () => {
            setAndroidOpening(true);
            await IpcClient.getInstance().expoOpenAndroid({ appId });
        },
        onSuccess: () => {
            setAndroidOpening(false);
            showSuccess("Opened Android project in Android Studio (Expo)");
        },
        onError: () => setAndroidOpening(false),
    });

    const openIos = useMutation({
        mutationFn: async () => {
            setIosOpening(true);
            await IpcClient.getInstance().expoOpenIos({ appId });
        },
        onSuccess: () => {
            setIosOpening(false);
            showSuccess("Opened iOS project in Xcode (Expo)");
        },
        onError: () => setIosOpening(false),
    });

    if (isLoading || !isExpo) return null;

    return (
        <Card className="mt-1" data-testid="expo-controls">
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    Mobile Development (Expo)
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            IpcClient.getInstance().openExternalUrl(
                                "https://docs.expo.dev/bare/hello-world/",
                            );
                        }}
                        className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 flex items-center gap-1"
                    >
                        Need help?
                        <ExternalLink className="h-3 w-3" />
                    </Button>
                </CardTitle>
                <CardDescription>
                    Generate native projects with Expo prebuild and open them in your IDE
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-2 gap-2">
                    <Button
                        onClick={() => openIos.mutate()}
                        disabled={openIos.isPending}
                        variant="outline"
                        size="sm"
                        className="flex items-center gap-2 h-10"
                    >
                        {openIos.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Smartphone className="h-4 w-4" />
                        )}
                        <div className="text-left">
                            <div className="text-xs font-medium">
                                {iosOpening ? "Running..." : "Run iOS (Expo)"}
                            </div>
                            <div className="text-xs text-gray-500">Simulator/Device</div>
                        </div>
                    </Button>

                    <Button
                        onClick={() => openAndroid.mutate()}
                        disabled={openAndroid.isPending}
                        variant="outline"
                        size="sm"
                        className="flex items-center gap-2 h-10"
                    >
                        {openAndroid.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <TabletSmartphone className="h-4 w-4" />
                        )}
                        <div className="text-left">
                            <div className="text-xs font-medium">
                                {androidOpening ? "Running..." : "Run Android (Expo)"}
                            </div>
                            <div className="text-xs text-gray-500">Emulator/Device</div>
                        </div>
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
