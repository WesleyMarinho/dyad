import { experimental_createMCPClient, experimental_MCPClient } from "ai";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { db } from "../../db";
import { mcpServers } from "../../db/schema";

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const logger = log.scope("mcp_manager");

// Timeout para requests HTTP MCP (60 segundos)
const MCP_HTTP_TIMEOUT_MS = 60_000;
// Timeout para inicialização do cliente (30 segundos)
const MCP_CLIENT_INIT_TIMEOUT_MS = 30_000;

class McpManager {
  private static _instance: McpManager;
  static get instance(): McpManager {
    if (!this._instance) this._instance = new McpManager();
    return this._instance;
  }

  private clients = new Map<number, experimental_MCPClient>();
  private initializingClients = new Map<number, Promise<experimental_MCPClient>>();

  async getClient(serverId: number): Promise<experimental_MCPClient> {
    // Retorna cliente existente se já estiver inicializado
    const existing = this.clients.get(serverId);
    if (existing) {
      logger.log(`Returning existing MCP client for server ${serverId}`);
      return existing;
    }

    // Se já está inicializando, aguarda a inicialização em andamento
    const initializing = this.initializingClients.get(serverId);
    if (initializing) {
      logger.log(`Waiting for MCP client initialization for server ${serverId}`);
      return initializing;
    }

    // Inicia nova inicialização
    logger.log(`Initializing new MCP client for server ${serverId}`);
    const initPromise = this.initializeClient(serverId);
    this.initializingClients.set(serverId, initPromise);

    try {
      const client = await initPromise;
      this.clients.set(serverId, client);
      return client;
    } finally {
      this.initializingClients.delete(serverId);
    }
  }

  private async initializeClient(serverId: number): Promise<experimental_MCPClient> {
    const server = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    const s = server.find((x) => x.id === serverId);
    if (!s) throw new Error(`MCP server not found: ${serverId}`);
    
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    
    if (s.transport === "stdio") {
      const args = s.args ?? [];
      const env = s.envJson ?? undefined;
      if (!s.command) throw new Error("MCP server command is required");
      
      logger.log(`Creating stdio transport for server ${serverId}: ${s.command} ${args.join(' ')}`);
      transport = new StdioClientTransport({
        command: s.command,
        args,
        env,
      });
    } else if (s.transport === "http") {
      if (!s.url) throw new Error("HTTP MCP requires url");
      
      logger.log(`Creating HTTP transport for server ${serverId}: ${s.url}`);
      
      // Cria transport HTTP com timeout configurado via requestInit
      const url = new URL(s.url as string);
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          // Nota: AbortSignal.timeout só está disponível em versões modernas do Node
          // Para compatibilidade, não adicionamos timeout global aqui
          // O timeout é gerenciado no nível de cada chamada de tools()
        },
      });
    } else {
      throw new Error(`Unsupported MCP transport: ${s.transport}`);
    }

    // Cria cliente com timeout de inicialização
    const clientPromise = experimental_createMCPClient({
      transport,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`MCP client initialization timeout for server ${serverId} after ${MCP_CLIENT_INIT_TIMEOUT_MS}ms`));
      }, MCP_CLIENT_INIT_TIMEOUT_MS);
    });

    try {
      const client = await Promise.race([clientPromise, timeoutPromise]);
      logger.log(`MCP client initialized successfully for server ${serverId}`);
      return client;
    } catch (error) {
      logger.error(`Failed to initialize MCP client for server ${serverId}:`, error);
      throw error;
    }
  }

  dispose(serverId: number) {
    const c = this.clients.get(serverId);
    if (c) {
      try {
        logger.log(`Disposing MCP client for server ${serverId}`);
        c.close();
      } catch (error) {
        logger.error(`Error closing MCP client for server ${serverId}:`, error);
      }
      this.clients.delete(serverId);
    }
    // Também remove do mapa de inicialização se existir
    this.initializingClients.delete(serverId);
  }

  disposeAll() {
    logger.log(`Disposing all MCP clients (${this.clients.size} clients)`);
    for (const [serverId] of this.clients) {
      this.dispose(serverId);
    }
  }
}

export const mcpManager = McpManager.instance;
