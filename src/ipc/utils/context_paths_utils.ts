import { AppChatContext, AppChatContextSchema, GlobPath } from "@/lib/schemas";
import { DEFAULT_EXCLUDE_GLOBS } from "@/shared/contextDefaults";
import log from "electron-log";

const logger = log.scope("context_paths_utils");

function normalizeExcludePaths(excludePaths?: GlobPath[]): GlobPath[] {
  const sanitized: GlobPath[] = (excludePaths ?? []).map((path) => ({
    globPath: path.globPath.trim(),
  }));

  const existing = new Set(sanitized.map((path) => path.globPath));

  const normalized: GlobPath[] = [...sanitized];
  for (const globPath of DEFAULT_EXCLUDE_GLOBS) {
    if (!existing.has(globPath)) {
      normalized.push({ globPath });
    }
  }
  return normalized;
}

export function validateChatContext(chatContext: unknown): AppChatContext {
  if (!chatContext) {
    return {
      contextPaths: [],
      smartContextAutoIncludes: [],
      excludePaths: normalizeExcludePaths(),
    };
  }

  try {
    // Validate that the contextPaths data matches the expected schema
    const parsed = AppChatContextSchema.parse(chatContext);
    return {
      ...parsed,
      excludePaths: normalizeExcludePaths(parsed.excludePaths),
    };
  } catch (error) {
    logger.warn("Invalid contextPaths data:", error);
    // Return empty array as fallback if validation fails
    return {
      contextPaths: [],
      smartContextAutoIncludes: [],
      excludePaths: normalizeExcludePaths(),
    };
  }
}
