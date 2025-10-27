import { spawn } from "child_process";
import log from "electron-log";
import { constants } from "fs";
import { access } from "fs/promises";
import { dirname } from "path";
import { getEnvVar } from "./read_env";

const logger = log.scope("geminiCliDetector");

export interface GeminiCliInfo {
  path: string | null;
  version?: string;
  isAvailable: boolean;
  authStatus: "unknown" | "ok" | "error";
  errorMessage?: string;
}

export interface DetectGeminiCliOptions {
  explicitPath?: string;
  autoDetect?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 5_000;

const DEFAULT_PATH_CANDIDATES = [
  "gemini",
  "/usr/local/bin/gemini",
  "/opt/homebrew/bin/gemini",
  "/usr/bin/gemini",
  "C:\\Program Files\\Google\\Gemini CLI\\gemini.exe",
  "C:\\Program Files (x86)\\Google\\Gemini CLI\\gemini.exe",
];

async function ensureExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({ ok: false, stdout: "", stderr: error.message });
    });

    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function resolveCliPath(
  options: DetectGeminiCliOptions,
): Promise<{ path: string | null; error?: string }> {
  const candidates: string[] = [];

  if (options.explicitPath) {
    candidates.push(options.explicitPath);
  }

  const envPath = getEnvVar("GEMINI_CLI_PATH");
  if (envPath) {
    candidates.push(envPath);
  }

  if (options.autoDetect !== false) {
    candidates.push(process.env.PATH ? "gemini" : "");
    candidates.push(...DEFAULT_PATH_CANDIDATES);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;

    const command =
      candidate.includes("/") || candidate.includes("\\")
        ? candidate
        : await findInPath(candidate);

    if (!command) {
      continue;
    }

    const executable = await ensureExecutable(command);
    if (!executable) {
      logger.debug(`Gemini CLI path exists but is not executable: ${command}`);
      continue;
    }

    return { path: command };
  }

  return { path: null, error: "Gemini CLI executable not found" };
}

async function findInPath(binary: string): Promise<string | null> {
  const whichCommand = process.platform === "win32" ? "where" : "which";
  const result = await runCommand(whichCommand, [binary], DEFAULT_TIMEOUT);
  if (result.ok) {
    const resolvedPath = result.stdout.split("\n").map((s) => s.trim())[0];
    if (resolvedPath) {
      return resolvedPath;
    }
  }
  return null;
}

async function readVersion(
  cliPath: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const result = await runCommand(cliPath, ["--version"], timeoutMs);
  if (!result.ok) {
    logger.debug(
      `Unable to read Gemini CLI version from ${cliPath}: ${result.stderr}`,
    );
    return undefined;
  }

  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  if (match?.[1]) {
    return match[1];
  }
  const trimmed = result.stdout.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Attempt to detect Gemini CLI availability and gather minimal metadata.
 */
export async function detectGeminiCli(
  options: DetectGeminiCliOptions = {},
): Promise<GeminiCliInfo> {
  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    const { path, error } = await resolveCliPath(options);

    if (!path) {
      return {
        path: null,
        isAvailable: false,
        authStatus: "unknown",
        errorMessage: error,
      };
    }

    const version = await readVersion(path, timeoutMs);

    // Basic sanity check: ensure the directory exists.
    try {
      await access(dirname(path), constants.R_OK);
    } catch {
      logger.debug(`Gemini CLI directory is not readable: ${dirname(path)}`);
    }

    return {
      path,
      version,
      isAvailable: true,
      authStatus: "unknown",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : JSON.stringify(error);
    logger.error("Failed to detect Gemini CLI", message);
    return {
      path: null,
      isAvailable: false,
      authStatus: "unknown",
      errorMessage: message,
    };
  }
}
