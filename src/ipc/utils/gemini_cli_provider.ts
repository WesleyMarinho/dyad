import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { spawn } from "child_process";
import log from "electron-log";
import { TextEncoder } from "util";
import { detectGeminiCli } from "./gemini_cli_detector";

const logger = log.scope("geminiCliProvider");

export interface GeminiCliCallConfig {
  cliPath: string;
  modelId: string;
  timeoutMs?: number;
  extraArgs?: string[];
}

export interface GeminiCliUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface CliExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: Error;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function runGeminiCliCommand(
  config: GeminiCliCallConfig,
  prompt: string,
): Promise<CliExecutionResult> {
  const args = [
    "--output-format",
    "json",
    "--approval-mode",
    "yolo",
    "--model",
    config.modelId,
    "--prompt",
    prompt,
  ];

  if (config.extraArgs?.length) {
    args.push(...config.extraArgs);
  }

  return new Promise((resolve) => {
    const child = spawn(config.cliPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
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
      resolve({ success: false, stdout, stderr, error });
    });

    child.on("close", (code) => {
      resolve({ success: code === 0, stdout, stderr });
    });
  });
}

function formatMessagesAsPrompt(messages: any[]): string {
  if (!Array.isArray(messages)) return "";

  const segments: string[] = [];

  for (const message of messages) {
    const role = message?.role ?? "user";
    const parts = Array.isArray(message?.content)
      ? message.content
          .filter((part: any) => part?.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text)
      : typeof message?.content === "string"
        ? [message.content]
        : [];

    if (parts.length === 0) {
      continue;
    }

    const prefix =
      role === "system"
        ? "System"
        : role === "assistant"
          ? "Assistant"
          : role === "tool"
            ? "Tool"
            : "User";

    segments.push(`${prefix}:\n${parts.join("\n")}`);
  }

  return segments.join("\n\n");
}

function parseCliJson(output: string): { text: string; usage?: GeminiCliUsage } {
  try {
    const parsed = JSON.parse(output);
    const text =
      typeof parsed?.response === "string"
        ? parsed.response
        : typeof parsed === "string"
          ? parsed
          : "";

    const stats = parsed?.stats;
    const models = stats?.models;

    let usage: GeminiCliUsage | undefined;
    if (models && typeof models === "object") {
      const firstModelEntry = Object.values<any>(models)[0];
      if (firstModelEntry?.tokens) {
        usage = {
          inputTokens: firstModelEntry.tokens.prompt,
          outputTokens: firstModelEntry.tokens.candidates,
          totalTokens: firstModelEntry.tokens.total,
        };
      }
    }

    return { text, usage };
  } catch (error) {
    logger.warn("Failed to parse Gemini CLI JSON output", error);
    return { text: output.trim() };
  }
}

function createStreamingResponse(
  text: string,
  usage: GeminiCliUsage | undefined,
  modelId: string,
): Response {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const id = `gemini-cli-${created}`;

  const usagePayload =
    usage && (usage.inputTokens || usage.outputTokens || usage.totalTokens)
      ? {
          prompt_tokens: usage.inputTokens ?? 0,
          completion_tokens: usage.outputTokens ?? 0,
          total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        }
      : undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );

      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { content: text },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );

      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
            ...(usagePayload ? { usage: usagePayload } : {}),
          })}\n\n`,
        ),
      );

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}

function createJsonResponse(
  text: string,
  usage: GeminiCliUsage | undefined,
  modelId: string,
): Response {
  const created = Math.floor(Date.now() / 1000);
  const id = `gemini-cli-${created}`;

  const usagePayload =
    usage && (usage.inputTokens || usage.outputTokens || usage.totalTokens)
      ? {
          prompt_tokens: usage.inputTokens ?? 0,
          completion_tokens: usage.outputTokens ?? 0,
          total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        }
      : undefined;

  const body = {
    id,
    object: "chat.completion",
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    ...(usagePayload ? { usage: usagePayload } : {}),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createCliFetch(config: GeminiCliCallConfig): FetchFunction {
  return async (_url, init) => {
    const body = init?.body
      ? typeof init.body === "string"
        ? JSON.parse(init.body)
        : init.body
      : {};

    const messages = body?.messages ?? [];
    const prompt = formatMessagesAsPrompt(messages);

    const execResult = await runGeminiCliCommand(config, prompt);
    if (!execResult.success) {
      const errorPayload =
        tryParseError(execResult.stdout) ??
        tryParseError(execResult.stderr) ?? {
          message:
            execResult.stderr?.trim() ||
            execResult.stdout?.trim() ||
            execResult.error?.message ||
            "Gemini CLI failed",
        };

      const combinedOutput = [execResult.stderr, execResult.stdout]
        .filter(Boolean)
        .join("\n");
      const quotaMessage =
        detectQuotaMessage(errorPayload.message) ??
        detectQuotaMessage(combinedOutput);

      if (quotaMessage) {
        return new Response(
          JSON.stringify({
            error: {
              message: quotaMessage,
              type: "rate_limit_exceeded",
              code: "quota_exceeded",
            },
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          error: {
            message: errorPayload.message,
            type: "gemini_cli_error",
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const { text, usage } = parseCliJson(execResult.stdout);
    const isStreaming = body?.stream === true;
    return isStreaming
      ? createStreamingResponse(text, usage, config.modelId)
      : createJsonResponse(text, usage, config.modelId);
  };
}

function tryParseError(output: string) {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    if (parsed?.error?.message) {
      return { message: parsed.error.message };
    }
  } catch {
    // Ignore JSON parse failures.
  }
  return null;
}

function detectQuotaMessage(rawMessage: string | undefined | null): string | null {
  if (!rawMessage) return null;
  const lower = rawMessage.toLowerCase();
  if (
    lower.includes("quota exceeded") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("resource_exhausted")
  ) {
    const lines = rawMessage.split(/\r?\n/);
    const quotaLine =
      lines.find((line) => line.toLowerCase().includes("quota exceeded")) ??
      lines.find((line) =>
        line.toLowerCase().includes("rate_limit_exceeded"),
      ) ??
      rawMessage;
    return quotaLine.trim();
  }
  return null;
}

export async function createGeminiCliModel(
  modelId: string,
  options: Omit<GeminiCliCallConfig, "modelId">,
): Promise<LanguageModelV2> {
  const provider = createOpenAICompatible({
    name: "gemini-cli",
    baseURL: "http://localhost",
    fetch: createCliFetch({
      cliPath: options.cliPath,
      modelId,
      timeoutMs: options.timeoutMs,
      extraArgs: options.extraArgs,
    }),
  });

  return provider(modelId);
}

export async function ensureGeminiCliAvailable(
  options: { explicitPath?: string; autoDetect?: boolean } = {},
) {
  const info = await detectGeminiCli({
    explicitPath: options.explicitPath,
    autoDetect: options.autoDetect,
  });

  if (!info.isAvailable || !info.path) {
    throw new Error(
      info.errorMessage ??
        "Gemini CLI is not available. Install it from https://github.com/google-gemini/gemini-cli and run `gemini auth login`.",
    );
  }

  return info;
}
