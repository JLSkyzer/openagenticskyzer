// Ambient type declaration for fake-mcp-http-server.cjs, so the dynamic `import()` of it from the
// strict-mode-checked tests/mcp-client.test.mts resolves to real types instead of `any` — the .cjs
// implementation itself stays untyped JS, matching fixtures/fake-mcp-server.cjs's own style.
export interface FakeMcpHttpServerReceivedRequest {
  headers: Record<string, string | string[] | undefined>;
  message: { jsonrpc: '2.0'; id?: string; method: string; params?: unknown };
}

export interface FakeMcpHttpServer {
  url: string;
  sessionId: string;
  receivedRequests: FakeMcpHttpServerReceivedRequest[];
  close(): Promise<void>;
}

export function startFakeMcpHttpServer(
  options?: { mode?: 'json' | 'sse'; sessionId?: string },
): Promise<FakeMcpHttpServer>;
