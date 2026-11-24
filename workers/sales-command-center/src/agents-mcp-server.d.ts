declare module "agents/mcp/server" {
  export function createMcpHandler(serverFactory: () => unknown, options?: Record<string, unknown>): {
    fetch(request: Request, options?: Record<string, unknown>): Promise<Response>;
  };
}
