# Codex CLI Integration

This document outlines how Dyad integrates with the OpenAI Codex CLI, providing a local command-line path to OpenAI models with the same fallback guarantees we provide for the Google Gemini CLI.

## Overview

The Codex CLI integration enables Dyad to send prompts through the `codex` command-line tool. When the CLI is unavailable or encounters rate limits, Dyad can automatically fall back to the standard OpenAI API (when an API key is configured) so conversations never stall.

### Core Components

1. **Detection** (`src/ipc/utils/codex_cli_detector.ts`)
   - Locates the Codex CLI executable (`codex`, `openai`, etc.)
   - Reports version information when available
   - Respects the `CODEX_CLI_PATH` environment variable

2. **CLI Provider** (`src/ipc/utils/codex_cli_provider.ts`)
   - Bridges Codex CLI responses into an OpenAI-compatible format
   - Streams responses using server-sent events for parity with API calls
   - Surfaces quota errors (HTTP 429) to the renderer so the UI can inform the user immediately

3. **Model Client Wiring** (`src/ipc/utils/get_model_client.ts`)
   - Adds a connection mode selector (`api`, `cli`, `auto`) for OpenAI models
   - Falls back to the OpenAI API automatically when requested

4. **Settings UI** (`src/components/settings/OpenAIConfiguration.tsx`)
   - Configure API key, CLI path, auto-detection, fallback behaviour, timeout, and preferred models
   - Includes a “Check CLI” button that runs detection and shows the result inline

## Configuration

### Environment Variables

- `OPENAI_API_KEY`: Optional API key for OpenAI HTTP calls (required for API fallback)
- `CODEX_CLI_PATH`: Optional explicit path to the Codex CLI executable

### Provider Settings

In **Settings → AI Providers → OpenAI** you can control:

| Setting              | Description |
| -------------------- | ----------- |
| Connection Mode      | `API only`, `Codex CLI only`, or `Auto` (CLI first, API fallback) |
| CLI Executable Path  | Explicit path to the Codex binary; leave blank to rely on detection |
| Auto-detect CLI      | Searches default locations and PATH for the executable |
| Allow API Fallback   | When enabled, failures in CLI mode automatically retry via the HTTP API |
| Preferred CLI Models | Comma-separated list used to select the CLI model (first matching model wins) |
| CLI Timeout          | Execution timeout in milliseconds (default: 60,000) |

## Usage

1. Install the Codex CLI (see [GitHub – zed-industries/codex-acp](https://github.com/zed-industries/codex-acp) for reference).
2. Ensure it is on your `PATH` or set `CODEX_CLI_PATH`.
3. In Dyad, open **Settings → AI Providers → OpenAI**, choose `Codex CLI only` or `Auto`, and press **Check CLI**.
4. Provide an `OPENAI_API_KEY` if you want API fallback.

Once configured, Dyad will route OpenAI requests through the CLI and gracefully fall back when the CLI is unavailable or rate limited.
