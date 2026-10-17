// Type declarations for the plain-JS main.cjs, consumed only by tests that need to
// exercise its exported pure logic (buildCsp, chooseLoadTarget, resolveMainDataHome, ...)
// without a real Electron window — see electron/tests/renderer-loading.test.mts and
// electron/tests/main-data-home.test.mts.
export function resolveMainDataHome(env?: Record<string, string | undefined>, userHome?: string): Promise<string>;

export function startupFailure(error: unknown): { title: string; message: string };

export function buildCsp(isPackaged: boolean): string;

export function chooseLoadTarget(options: {
  isPackaged: boolean;
  devFlag: string | undefined;
}): { mode: 'url' | 'file'; target: string };

export function handleBackendRequest(event: unknown, request: unknown): Promise<unknown>;
