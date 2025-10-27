import { eq } from "drizzle-orm";
import log from "electron-log";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { getDyadAppPath } from "../../paths/paths";
import { simpleSpawn } from "../utils/simpleSpawn";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("expo_handlers");
const handle = createLoggedHandler(logger);

async function getApp(appId: number) {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
  });
  if (!app) {
    throw new Error(`App with id ${appId} not found`);
  }
  return app;
}

export function isExpoProject(appPath: string): boolean {
  try {
    const pkgJsonPath = path.join(appPath, "package.json");
    const appJsonPath = path.join(appPath, "app.json");
    const appConfigJs = path.join(appPath, "app.config.js");
    const appConfigTs = path.join(appPath, "app.config.ts");

    // If package.json has expo dependency, it's an Expo app
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps["expo"]) return true;
    }

    // Or if Expo config files exist
    if (fs.existsSync(appJsonPath) || fs.existsSync(appConfigJs) || fs.existsSync(appConfigTs)) {
      return true;
    }
  } catch (e) {
    logger.warn("Failed to detect Expo project:", e);
  }
  return false;
}

function getAndroidEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  // If ANDROID_HOME/ANDROID_SDK_ROOT not set, try common locations
  const home = os.homedir();
  const candidates = [
    path.join(home, "Android", "Sdk"),
    path.join(home, "Android", "sdk"),
  ];
  const existing = candidates.find((p) => fs.existsSync(p));
  if (existing) {
    if (!env["ANDROID_HOME"]) env["ANDROID_HOME"] = existing;
    if (!env["ANDROID_SDK_ROOT"]) env["ANDROID_SDK_ROOT"] = existing;
    const platformTools = path.join(existing, "platform-tools");
    const buildTools = path.join(existing, "build-tools");
    const toolsBin = path.join(existing, "tools", "bin");
    const extras = [platformTools, buildTools, toolsBin]
      .filter((p) => fs.existsSync(p))
      .join(":");
    env["PATH"] = extras
      ? `${extras}:${env["PATH"] ?? ""}`
      : env["PATH"] ?? "";
  }
  env["LANG"] = env["LANG"] || "en_US.UTF-8";
  return env;
}

function getAndroidPackageName(appPath: string): string | null {
  try {
    const manifestPath = path.join(
      appPath,
      "android",
      "app",
      "src",
      "main",
      "AndroidManifest.xml",
    );
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    const manifest = fs.readFileSync(manifestPath, "utf8");
    const packageMatch = manifest.match(/<manifest[^>]*package="([^"]+)"/);
    return packageMatch?.[1] ?? null;
  } catch (error) {
    logger.warn("Unable to read AndroidManifest.xml", error);
    return null;
  }
}

async function launchAndroidApp({
  packageName,
  appPath,
  env,
}: {
  packageName: string;
  appPath: string;
  env: Record<string, string>;
}) {
  try {
    await simpleSpawn({
      command: `adb shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
      cwd: appPath,
      successMessage: `Launched ${packageName} on connected Android device/emulator`,
      errorPrefix: `Failed to launch ${packageName}`,
      env,
    });
  } catch (error) {
    logger.warn(`Unable to auto-launch ${packageName} via adb`, error);
  }
}

async function runExpoAndroid({
  appPath,
  appId,
}: {
  appPath: string;
  appId: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = getAndroidEnv();
    const packageName = getAndroidPackageName(appPath);
    let launchScheduled = false;
    let resolved = false;
    let missingBabelPluginError: Error | null = null;

    const child = spawn("npx expo run:android", {
      cwd: appPath,
      shell: true,
      stdio: "pipe",
      env,
    });

    const scheduleLaunch = () => {
      if (!packageName || launchScheduled) {
        return;
      }
      launchScheduled = true;
      setTimeout(() => {
        void launchAndroidApp({ packageName, appPath, env });
      }, 2000);
    };

    const handleOutput = (text: string, isStdErr: boolean) => {
      if (isStdErr) {
        logger.error(text);
      } else {
        logger.info(text);
      }

      if (!missingBabelPluginError && text.includes("babel-plugin-module-resolver")) {
        missingBabelPluginError = new Error(text);
        child.kill();
        return;
      }

      if (text.includes("BUILD SUCCESSFUL")) {
        scheduleLaunch();
      }

      if (!resolved && text.includes("Waiting on http://")) {
        resolved = true;
        resolve();
      }
    };

    child.stdout?.on("data", (data) => handleOutput(data.toString(), false));
    child.stderr?.on("data", (data) => handleOutput(data.toString(), true));

    child.on("error", (error) => {
      if (!resolved) {
        reject(error);
      }
    });

    child.on("close", (code) => {
      if (missingBabelPluginError) {
        reject(missingBabelPluginError);
        return;
      }

      if (resolved) {
        logger.info(
          `expo run:android process for app ${appId} closed with code ${code}`,
        );
        return;
      }

      reject(new Error(`expo run:android exited with code ${code}`));
    });
  });
}


/**
 * Ensures the expo-modules-core includeBuild line has a unique name to avoid Gradle name clashes.
 * Expo prebuild regenerates this line, so we patch it after each prebuild.
 */
function patchExpoModulesCoreIncludeBuild(appPath: string) {
  try {
    const settingsGradlePath = path.join(appPath, "android", "settings.gradle");
    if (!fs.existsSync(settingsGradlePath)) return;

    let content = fs.readFileSync(settingsGradlePath, "utf8");
    const includeRegex = /includeBuild\([^\n]*expo-modules-core[^\n]*\).*?\n?/g;
    if (includeRegex.test(content)) {
      content = content.replace(includeRegex, "");
    }

    if (!content.includes("expo-modules-core")) {
      let expoModulesCorePath: string | null = null;
      const pnpmDir = path.join(appPath, "node_modules", ".pnpm");
      if (fs.existsSync(pnpmDir)) {
        const entries = fs.readdirSync(pnpmDir);
        const match = entries.find((entry) =>
          entry.startsWith("expo-modules-core@"),
        );
        if (match) {
          const potentialPath = path.join(
            pnpmDir,
            match,
            "node_modules",
            "expo-modules-core",
          );
          if (fs.existsSync(potentialPath)) {
            expoModulesCorePath = potentialPath;
          }
        }
      }

      if (!expoModulesCorePath) {
        logger.warn(
          "Could not locate expo-modules-core package. Skipping includeBuild patch.",
        );
        return;
      }

      const includeLine = `includeBuild("${expoModulesCorePath}/android") {\n  name = "expo-modules-core-build"\n}\n`;
      content = `${content.trimEnd()}\n\n${includeLine}`;
      fs.writeFileSync(settingsGradlePath, `${content}\n`, "utf8");
      logger.info(
        `Added expo-modules-core includeBuild pointing to ${expoModulesCorePath}`,
      );
    }
  } catch (e) {
    logger.warn(
      "Failed to patch expo-modules-core includeBuild in settings.gradle",
      e,
    );
  }
}

export function registerExpoHandlers() {
  handle(
    "is-expo",
    async (_, { appId }: { appId: number }): Promise<boolean> => {
      const app = await getApp(appId);
      const appPath = getDyadAppPath(app.path);
      return isExpoProject(appPath);
    },
  );

  handle(
    "expo-open-android",
    async (_, { appId }: { appId: number }): Promise<void> => {
      const app = await getApp(appId);
      const appPath = getDyadAppPath(app.path);

      if (!isExpoProject(appPath)) {
        throw new Error("This app doesn't look like an Expo project");
      }

      // Ensure native android project exists and open in Android Studio
      const prebuild = async () =>
        simpleSpawn({
          command: "npx expo prebuild -p android",
          cwd: appPath,
          successMessage: "Expo prebuild (android) completed successfully",
          errorPrefix: "Failed to run 'expo prebuild' for android",
          env: getAndroidEnv(),
        });

      try {
        await prebuild();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Known issue: missing Ajv v8 path required by schema-utils/expo-router plugin
        if (msg.includes("ajv/dist/compile/codegen")) {
          // Attempt to install compatible versions and retry
          await simpleSpawn({
            command:
              "pnpm add -D ajv@^8 ajv-keywords@^5 schema-utils@^4 || npm install -D ajv@^8 ajv-keywords@^5 schema-utils@^4 --legacy-peer-deps",
            cwd: appPath,
            successMessage: "Installed Ajv dependencies required by Expo plugins",
            errorPrefix: "Failed to install Ajv dependencies",
            env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
          });
          await prebuild();
        } else {
          throw err;
        }
      }
      
      // Ensure expo-modules-core includeBuild is patched to avoid Gradle name clashes
      patchExpoModulesCoreIncludeBuild(appPath);
      
      try {
        await runExpoAndroid({ appPath, appId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Known issue: Metro bundler missing babel-plugin-module-resolver
        if (msg.includes("babel-plugin-module-resolver")) {
          logger.info("Installing missing babel-plugin-module-resolver for Metro bundler");
          await simpleSpawn({
            command:
              "pnpm add -D babel-plugin-module-resolver || npm install -D babel-plugin-module-resolver --legacy-peer-deps",
            cwd: appPath,
            successMessage: "Installed babel-plugin-module-resolver",
            errorPrefix: "Failed to install babel-plugin-module-resolver",
            env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
          });
          logger.info("Retrying expo run:android after installing Babel plugin");
          await runExpoAndroid({ appPath, appId });
        } else {
          throw err;
        }
      }
    },
  );

  handle(
    "expo-open-ios",
    async (_, { appId }: { appId: number }): Promise<void> => {
      const app = await getApp(appId);
      const appPath = getDyadAppPath(app.path);

      if (!isExpoProject(appPath)) {
        throw new Error("This app doesn't look like an Expo project");
      }

      const prebuild = async () =>
        simpleSpawn({
          command: "npx expo prebuild -p ios",
          cwd: appPath,
          successMessage: "Expo prebuild (ios) completed successfully",
          errorPrefix: "Failed to run 'expo prebuild' for iOS",
          env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
        });

      try {
        await prebuild();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ajv/dist/compile/codegen")) {
          await simpleSpawn({
            command:
              "pnpm add -D ajv@^8 ajv-keywords@^5 schema-utils@^4 || npm install -D ajv@^8 ajv-keywords@^5 schema-utils@^4 --legacy-peer-deps",
            cwd: appPath,
            successMessage: "Installed Ajv dependencies required by Expo plugins",
            errorPrefix: "Failed to install Ajv dependencies",
            env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
          });
          await prebuild();
        } else {
          throw err;
        }
      }

      await simpleSpawn({
        command: "npx expo run:ios",
        cwd: appPath,
        successMessage: "iOS run completed (built and installed on simulator/device)",
        errorPrefix: "Failed to run iOS project",
        env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
      });
    },
  );
}
