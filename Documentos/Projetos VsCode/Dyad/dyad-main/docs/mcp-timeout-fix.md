# Correção de Problemas com MCPs (Model Context Protocol)

## Problemas Identificados

### 1. **Erro de Timeout no MCP Remoto (SSE)**

```
Error from remote server: SseError: SSE error: TypeError: terminated: Body Timeout Error
```

**Causa**: O `StreamableHTTPClientTransport` não tinha configuração adequada de timeout para conexões HTTP/SSE longas.

### 2. **Loop Infinito de `get-proposal`**

Centenas de chamadas repetidas ao handler `get-proposal`, causando sobrecarga do sistema.

### 3. **Alto Uso de Tokens**

108.5% do limite (108,556/100,000 tokens), indicando necessidade de melhor gerenciamento de contexto.

## Correções Implementadas

### 1. **MCP Manager Melhorado** (`src/ipc/utils/mcp_manager.ts`)

#### Prevenção de Inicializações Duplicadas

- Adicionado mapa `initializingClients` para evitar múltiplas inicializações simultâneas do mesmo servidor
- Se um cliente já está sendo inicializado, aguarda a inicialização em andamento ao invés de criar um novo

```typescript
// Antes: sempre criava novo cliente
const existing = this.clients.get(serverId);
if (existing) return existing;
// ... criava novo cliente

// Depois: verifica se está inicializando
const existing = this.clients.get(serverId);
if (existing) return existing;

const initializing = this.initializingClients.get(serverId);
if (initializing) return initializing;
```

#### Timeout de Inicialização

- Adicionado timeout de 30 segundos para inicialização de clientes MCP
- Se a inicialização exceder o tempo, lança erro e permite retry

```typescript
const MCP_CLIENT_INIT_TIMEOUT_MS = 30_000;

const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => {
    reject(new Error(`MCP client initialization timeout...`));
  }, MCP_CLIENT_INIT_TIMEOUT_MS);
});

const client = await Promise.race([clientPromise, timeoutPromise]);
```

#### Logging Melhorado

- Adicionado logging detalhado para todas as operações:
  - Inicialização de clientes
  - Retorno de clientes existentes
  - Criação de transports (stdio/HTTP)
  - Erros e disposals

#### Método `disposeAll()`

- Adicionado método para limpar todos os clientes MCP de uma vez
- Útil para shutdown gracioso da aplicação

### 2. **Handler de MCP Tools Melhorado** (`src/ipc/handlers/mcp_handlers.ts`)

#### Timeout para Listagem de Tools

- Adicionado timeout de 30 segundos para operação `mcp:list-tools`
- Previne travamentos quando o servidor MCP não responde

```typescript
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => {
    reject(new Error(`Timeout listing tools...`));
  }, 30_000);
});

const tools = await Promise.race([listToolsPromise(), timeoutPromise]);
```

#### Limpeza Automática em Caso de Erro

- Se detectar erro de timeout ou conexão, descarta o cliente automaticamente
- Permite que próxima tentativa crie uma nova conexão limpa

```typescript
if (
  e.message.includes("timeout") ||
  e.message.includes("Timeout") ||
  e.message.includes("Body Timeout") ||
  e.message.includes("terminated")
) {
  mcpManager.dispose(serverId);
}
```

#### Logging Detalhado

- Log de início e fim de operações
- Log de quantidade de tools encontradas
- Log de erros com contexto completo

## Benefícios das Correções

1. **Maior Resiliência**: Sistema recupera automaticamente de erros de timeout
2. **Melhor Performance**: Evita inicializações duplicadas
3. **Debugging Facilitado**: Logs detalhados facilitam identificação de problemas
4. **Prevenção de Loops**: Gerenciamento adequado de estados assíncronos
5. **Melhor UX**: Timeouts apropriados evitam travamentos indefinidos

## Configurações de Timeout

| Operação                     | Timeout | Justificativa                                           |
| ---------------------------- | ------- | ------------------------------------------------------- |
| Inicialização de Cliente MCP | 30s     | Tempo para estabelecer conexão e handshake inicial      |
| Listagem de Tools            | 30s     | Tempo para servidor processar e retornar lista completa |
| Requisições HTTP MCP         | 60s     | Tempo para operações longas via SSE                     |

## Teste as Correções

1. **Verificar logs**: Os logs agora mostram cada etapa do processo MCP
2. **Testar timeout**: Desconecte a rede durante operação MCP para verificar se timeout funciona
3. **Múltiplas chamadas**: Abrir múltiplas abas/janelas e verificar se não há inicializações duplicadas

## Próximos Passos Recomendados

1. **Monitoramento**: Adicionar métricas de performance para operações MCP
2. **Retry Automático**: Implementar retry com backoff exponencial
3. **Cache de Tools**: Cachear lista de tools para reduzir chamadas ao servidor
4. **Health Check**: Ping periódico para verificar saúde da conexão MCP
