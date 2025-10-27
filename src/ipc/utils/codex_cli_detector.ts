import { spawn } from "child_process";
import log from "electron-log";
import { constants } from "fs";
import { access } from "fs/promises";
import { dirname } from "path";
import { getEnvVar } from "./read_env";

const logger = log.scope("codexCliDetector");

export interface CodexCliInfo {
  path: string | null;
  version?: string;
  isAvailable: boolean;
  errorMessage?: string;
}

export interface DetectCodexCliOptions {
  explicitPath?: string;
  autoDetect?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 5_000;

const DEFAULT_PATH_CANDIDATES = [
  "codex",
  "openai",
  "/usr/local/bin/codex",
  "/usr/bin/codex",
  "C:\\Program Files\\OpenAI\\codex.exe",
  "C:\\Program Files\\OpenAI\\OpenAI.exe",
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

async function findInPath(binary: string): Promise<string | null> {
  const whichCommand = process.platform === "win32" ? "where" : "which";
  const result = await runCommand(whichCommand, [binary], DEFAULT_TIMEOUT);
  if (result.ok && result.stdout) {
    const resolvedPath = result.stdout.split("\n").map((line) => line.trim())[0];
    if (resolvedPath) {
      return resolvedPath;
    }
  }
  return null;
}

async function resolveCliPath(
  options: DetectCodexCliOptions,
): Promise<{ path: string | null; error?: string }> {
  const candidates: string[] = [];

  if (options.explicitPath) {
    candidates.push(options.explicitPath);
  }

  const envPath = getEnvVar("CODEX_CLI_PATH");
  if (envPath) {
    candidates.push(envPath);
  }

  if (options.autoDetect !== false) {
    candidates.push(process.env.PATH ? "codex" : "");
    candidates.push(...DEFAULT_PATH_CANDIDATES);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;

    const resolved =
      candidate.includes("/") || candidate.includes("\\")
        ? candidate
        : await findInPath(candidate);

    if (!resolved) continue;

    const executable = await ensureExecutable(resolved);
    if (!executable) {
      logger.debug(`Codex CLI path exists but is not executable: ${resolved}`);
      continue;
    }

    return { path: resolved };
  }

  return { path: null, error: "Codex CLI executable not found" };
}

async function readVersion(
  cliPath: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const result = await runCommand(cliPath, ["--version"], timeoutMs);
  if (!result.ok) {
    logger.debug(
      `Unable to read Codex CLI version from ${cliPath}: ${result.stderr}`,
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

export async function detectCodexCli(
  options: DetectCodexCliOptions = {},
): Promise<CodexCliInfo> {
  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    const { path, error } = await resolveCliPath(options);

    if (!path) {
      return {
        path: null,
        isAvailable: false,
        errorMessage: error,
      };
    }

    const version = await readVersion(path, timeoutMs);

    try {
      await access(dirname(path), constants.R_OK);
    } catch {
      logger.debug(`Codex CLI directory is not readable: ${dirname(path)}`);
    }

    return {
      path,
      version,
      isAvailable: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to detect Codex CLI", message);
    return {
      path: null,
      isAvailable: false,
      errorMessage: message,
    };
  }
}
