# Gemini CLI Integration

This document describes the comprehensive Gemini CLI integration system implemented in Dyad, following a similar approach to Zed IDE's local LLM tool integration.

## Overview

The Gemini CLI integration provides direct command-line interface access to Google's Gemini models, offering native performance and local processing capabilities while maintaining seamless fallback to API mode when needed.

## Architecture

### Core Components

1. **Detection & Validation** (`src/ipc/utils/gemini_cli_detector.ts`)
   - Auto-detects Gemini CLI installation
   - Resolves executable path and version

2. **CLI Provider Bridge** (`src/ipc/utils/gemini_cli_provider.ts`)
   - Wraps Gemini CLI usage in an OpenAI-compatible interface
   - Converts responses (including streaming) into the standard format

3. **Model Client Integration** (`src/ipc/utils/get_model_client.ts`)
   - Chooses between CLI and API modes based on user settings
   - Handles automatic fallback logic

4. **Configuration Schema & UI**
   - Schema updates in `src/lib/schemas.ts`
   - Settings UI in `src/components/settings/GoogleConfiguration.tsx`

## Configuration

### Schema

```typescript
interface GeminiCliProviderSetting {
  cliPath?: string;           // Custom CLI path
  autoDetect: boolean;        // Auto-detect CLI installation
  fallbackToApi: boolean;     // Fallback to API on CLI failure
  timeout: number;           // Request timeout in ms
  preferredModels: string[];  // Preferred model order
}
```

### Environment Variables

- `GEMINI_CLI_PATH`: Custom path to Gemini CLI executable
- `GEMINI_API_KEY`: Fallback API key for API mode

### Default Configuration

```json
{
  "cliPath": undefined,
  "autoDetect": true,
  "fallbackToApi": true,
  "timeout": 60000,
  "preferredModels": [
    "gemini-2.5-pro",
    "gemini-2.5-flash"
  ]
}
```

## Usage

### Basic Setup

1. **Install Gemini CLI**:

   ```bash
   # Follow Google's installation instructions
   # https://ai.google.dev/cli
   ```

2. **Authenticate**:

   ```bash
   gemini auth login
   ```

3. **Configure in Dyad**:
   - Go to Settings → Providers → Gemini CLI
   - Enable auto-detection or specify custom path
   - Configure timeout and fallback options

### Programmatic Usage

```typescript
import { detectGeminiCli } from "./src/ipc/utils/gemini_cli_detector";
import { createGeminiCliProvider } from "./src/ipc/utils/gemini_cli_provider";

// Detect CLI
const cliInfo = await detectGeminiCli();
if (cliInfo.isAvailable) {
  // Create provider
  const provider = createGeminiCliProvider({
    cliPath: cliInfo.path,
    autoDetect: true,
    fallbackToApi: true,
  });
  
  // Use model
  const model = await provider("gemini-2.5-pro");
  const response = await model.doGenerate({
    prompt: "Hello, world!"
  });
}
```

## Features

### Auto-Detection

The system automatically detects Gemini CLI in:

- System PATH
- Common installation directories
- Custom paths from environment variables
- User-specified paths in settings

### Seamless Fallback

When CLI is unavailable or fails:

1. Automatic detection of failure type
2. Attempt recovery if possible
3. Seamless fallback to Google API
4. Maintain consistent user experience

### Performance Optimization

- **Response Time Monitoring**: Track CLI vs API performance
- **Automatic Recommendations**: Suggest optimal configuration
- **Caching**: Cache CLI detection results
- **Timeout Management**: Configurable timeouts with retry logic

### Error Handling

Comprehensive error classification:

- `cli_not_found`: CLI not installed or accessible
- `authentication_failed`: CLI not authenticated
- `execution_failed`: CLI execution errors
- `timeout`: Request timeouts
- `model_not_supported`: Unsupported models
- `unknown`: Unclassified errors

## Performance Metrics

### Tracked Metrics

- Request count and success rate
- Average response time (CLI vs API)
- Error and timeout rates
- Fallback frequency
- Response time percentiles (P50, P95, P99)

### Performance Thresholds

- Maximum average response time: 10 seconds
- Maximum error rate: 10%
- Maximum timeout rate: 5%
- High fallback rate warning: 50%

### Optimization Recommendations

The system provides automatic recommendations based on:

- Performance comparisons
- Error patterns
- Usage statistics
- Configuration analysis

## Security Considerations

### Authentication

- CLI authentication handled by Google's auth system
- API keys stored securely using Electron's safe storage
- No credentials stored in plain text

### Process Isolation

- CLI processes executed with proper isolation
- Timeout protection prevents hanging processes
- Error handling prevents process leakage

### Path Validation

- Custom CLI paths validated for security
- Prevents execution of unauthorized binaries
- Sandboxed execution environment

## Troubleshooting

### Common Issues

1. **CLI Not Found**
   - Verify installation: `gemini --version`
   - Check PATH environment variable
   - Specify custom path in settings

2. **Authentication Failed**
   - Run: `gemini auth login`
   - Verify Google account access
   - Check API quotas

3. **Performance Issues**
   - Check performance metrics in logs
   - Increase timeout settings
   - Consider API fallback for better performance

4. **Model Not Supported**
   - Check available models: `gemini models list`
   - Update CLI to latest version
   - Use fallback API mode

### Debug Logging

Enable detailed logging:

## Testing

The CLI integration reuses the existing provider test suites. Ensure both CLI and API paths are exercised when adding new scenarios.

## Future Enhancements

### Planned Features

1. **Advanced Caching**: Cache CLI responses for common queries
2. **Batch Processing**: Support for batch requests to CLI
3. **Model Auto-Selection**: Intelligent model selection based on query type
4. **Performance Profiles**: Pre-configured performance settings
5. **Health Monitoring**: Continuous CLI health checks

### Extension Points

The system is designed to be extensible:

- Add new CLI providers following the same pattern
- Implement custom error handling strategies
- Add performance monitoring plugins
- Create specialized configuration schemas

## Contributing

When contributing to the Gemini CLI integration:

1. Follow existing code patterns and TypeScript conventions
2. Add comprehensive tests for new features
3. Update documentation for API changes
4. Test CLI integration across different platforms
5. Verify performance impact of changes

## License

This integration follows the same license as the main Dyad project.

## Support

For issues with the Gemini CLI integration:

1. Check existing GitHub issues
2. Review performance metrics and logs
3. Verify CLI installation and authentication
4. Test with fallback API mode
5. Create detailed bug reports with system information

---

*This documentation covers the Gemini CLI integration system as implemented in Dyad, providing direct CLI access with intelligent fallback to API mode.*
