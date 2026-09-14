// Type declarations for the plain-JS main.cjs, consumed only by tests that need to
// exercise its exported pure logic (resolveSendPayload, buildCsp, chooseLoadTarget)
// without a real Electron window — see electron/tests/os-vault.cjs and
// electron/tests/renderer-loading.test.mts.
export function resolveSendPayload(
  connectionsService: { resolve(folder: string | null): Promise<Record<string, unknown>> },
  request: { op: string; payload?: Record<string, unknown> },
): Promise<{ op: string; payload: Record<string, unknown> }>;

export function createConnections(): Promise<unknown>;

export function buildCsp(isPackaged: boolean): string;

export function chooseLoadTarget(options: {
  isPackaged: boolean;
  devFlag: string | undefined;
}): { mode: 'url' | 'file'; target: string };

export function handleBackendRequest(event: unknown, request: unknown): Promise<unknown>;
