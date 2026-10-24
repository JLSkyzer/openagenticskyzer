/** Types for core/log-dir.cjs (CommonJS, required by main.cjs and imported by core/turn-log.mts). */
export function realLogDir(dataHome: string, options: { create: boolean }): Promise<string | null>;
