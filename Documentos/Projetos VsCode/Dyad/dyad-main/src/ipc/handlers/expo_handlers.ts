import { eq } from "drizzle-orm";
import log from "electron-log";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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


/**
 * Removes the problematic expo-modules-core includeBuild line from settings.gradle.
 * This line causes a Gradle name clash error with Gradle 8.3+.
 * Expo prebuild regenerates this line, so we remove it after each prebuild.
 */
function removeExpoModulesCoreIncludeBuild(appPath: string) {
  try {
    const settingsGradlePath = path.join(appPath, "android", "settings.gradle");
    if (!fs.existsSync(settingsGradlePath)) return;

    let content = fs.readFileSync(settingsGradlePath, "utf8");
    
    // Remove the includeBuild line for expo-modules-core
    const lines = content.split(/\r?\n/);
    const filtered = lines.filter((line) => {
      // Remove any line that includes expo-modules-core in an includeBuild statement
      return !(line.includes("includeBuild") && line.includes("expo-modules-core"));
    });

    if (filtered.length !== lines.length) {
      fs.writeFileSync(settingsGradlePath, filtered.join("\n"), "utf8");
      logger.info("Removed expo-modules-core includeBuild from settings.gradle (prevents Gradle name clash)");
    }
  } catch (e) {
    logger.warn("Failed to remove expo-modules-core includeBuild from settings.gradle", e);
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
      
      // Remove problematic expo-modules-core includeBuild line from settings.gradle
      removeExpoModulesCoreIncludeBuild(appPath);
      
      const runAndroid = async () =>
        simpleSpawn({
          command: "npx expo run:android",
          cwd: appPath,
          successMessage: "Android run completed (built and installed on device/emulator)",
          errorPrefix: "Failed to run Android project",
          env: getAndroidEnv(),
        });

      try {
        await runAndroid();
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
          await runAndroid();
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
