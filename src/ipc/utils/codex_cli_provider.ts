import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { spawn } from "child_process";
import log from "electron-log";
import { TextEncoder } from "util";
import { detectCodexCli } from "./codex_cli_detector";

const logger = log.scope("codexCliProvider");

export interface CodexCliCallConfig {
  cliPath: string;
  modelId: string;
  timeoutMs?: number;
  extraArgs?: string[];
  apiKey?: string;
}

interface CliExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: Error;
}

const DEFAULT_TIMEOUT_MS = 60_000;

async function runCodexCliCommand(
  config: CodexCliCallConfig,
  prompt: string,
): Promise<CliExecutionResult> {
  const args: string[] = [
    "exec",
    "--model",
    config.modelId,
    "--json",
    "--skip-git-repo-check",
  ];

  if (config.extraArgs?.length) {
    args.push(...config.extraArgs);
  }

  // Signal that prompt will come from stdin
  args.push("-");

  return new Promise((resolve) => {
    const child = spawn(config.cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: {
        ...process.env,
        NO_COLOR: "1",
        CODEX_DISABLE_ROLLOUT_RECORDER: "1",
        ...(config.apiKey ? { OPENAI_API_KEY: config.apiKey } : {}),
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

    child.stdin?.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
    child.stdin?.end();
  });
}

function formatMessagesAsPrompt(messages: any[]): string {
  if (!Array.isArray(messages)) return "";

  const segments: string[] = [];

  for (const message of messages) {
    const role = message?.role ?? "user";
    const parts = Array.isArray(message?.content)
      ? message.content
          .filter(
            (part: any) => part?.type === "text" && typeof part.text === "string",
          )
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

function detectQuotaMessage(rawMessage?: string | null): string | null {
  if (!rawMessage) return null;
  const normalized = rawMessage.toLowerCase();
  if (
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("429")
  ) {
    return (
      rawMessage
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "OpenAI quota exceeded."
    );
  }
  return null;
}

function parseCodexEvents(output: string) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let aggregatedText = "";
  let errorMessage: string | null = null;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event?.type === "error" && typeof event.message === "string") {
        errorMessage = event.message;
        continue;
      }

      if (
        event?.type === "response.output_text.delta" &&
        typeof event.delta === "string"
      ) {
        aggregatedText += event.delta;
        continue;
      }

      if (
        event?.type === "response.completed" &&
        Array.isArray(event.response?.output_text)
      ) {
        aggregatedText = event.response.output_text.join("");
        continue;
      }

      if (Array.isArray(event?.content)) {
        const contentText = event.content
          .map((part: any) => {
            if (typeof part === "string") return part;
            if (typeof part?.text === "string") return part.text;
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (contentText) {
          aggregatedText = contentText;
        }
      }
    } catch (error) {
      logger.debug("Failed to parse Codex CLI event", error);
    }
  }

  return {
    text: aggregatedText.trim() || lines.join("\n"),
    errorMessage,
  };
}

function createStreamingResponse(text: string, modelId: string): Response {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const id = `codex-cli-${created}`;

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

function createJsonResponse(text: string, modelId: string): Response {
  const created = Math.floor(Date.now() / 1000);
  const id = `codex-cli-${created}`;

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
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createCodexCliFetch(config: CodexCliCallConfig): FetchFunction {
  return async (_url, init) => {
    const body = init?.body
      ? typeof init.body === "string"
        ? JSON.parse(init.body)
        : init.body
      : {};

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const prompt = formatMessagesAsPrompt(messages);

    const execResult = await runCodexCliCommand(config, prompt);

    if (!execResult.success) {
      const quotaMessage =
        detectQuotaMessage(execResult.stderr) ??
        detectQuotaMessage(execResult.stdout);
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

      const unauthorizedMessage =
        execResult.stderr.includes("401") || execResult.stdout.includes("401")
          ? "Codex CLI returned 401 Unauthorized. Run `codex login` in a terminal (with the same account) or configure an OpenAI API key in Settings to use Codex."
          : null;

      const message =
        execResult.stderr.trim() ||
        execResult.stdout.trim() ||
        execResult.error?.message ||
        "Codex CLI failed";

      return new Response(
        JSON.stringify({
          error: {
            message: unauthorizedMessage ?? message,
            type: "codex_cli_error",
            code: unauthorizedMessage ? "unauthorized" : undefined,
          },
        }),
        {
          status: unauthorizedMessage ? 401 : 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const { text, errorMessage } = parseCodexEvents(execResult.stdout);

    if (errorMessage) {
      return new Response(
        JSON.stringify({
          error: {
            message: errorMessage,
            type: "codex_cli_error",
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const isStreaming = body?.stream === true;
    return isStreaming
      ? createStreamingResponse(text, config.modelId)
      : createJsonResponse(text, config.modelId);
  };
}

export async function createCodexCliModel(
  modelId: string,
  options: Omit<CodexCliCallConfig, "modelId">,
): Promise<LanguageModelV2> {
  const provider = createOpenAICompatible({
    name: "codex-cli",
    baseURL: "http://localhost",
    fetch: createCodexCliFetch({
      cliPath: options.cliPath,
      modelId,
      timeoutMs: options.timeoutMs,
      extraArgs: options.extraArgs,
    }),
  });

  return provider(modelId);
}

export async function ensureCodexCliAvailable(
  options: { explicitPath?: string; autoDetect?: boolean } = {},
) {
  const info = await detectCodexCli({
    explicitPath: options.explicitPath,
    autoDetect: options.autoDetect,
  });

  if (!info.isAvailable || !info.path) {
    throw new Error(
      info.errorMessage ??
        "Codex CLI is not available. Install it from https://github.com/openai/codex and ensure it is on your PATH.",
    );
  }

  return info;
}
