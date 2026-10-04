// Type declarations for the plain-JS core/data-home.cjs (shared by main.cjs, worker.mjs and core/data-dir.mts).
export const REDIRECT_FILE: 'redirect.json';

export function resolveDataHome(defaultHome: string): Promise<string>;

export function resolveHomes(
  env?: Record<string, string | undefined>,
  userHome?: string,
): Promise<{ defaultHome: string; dataHome: string }>;
