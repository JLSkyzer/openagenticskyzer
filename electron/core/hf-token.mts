const REAL_ENDPOINT = 'https://huggingface.co/api/whoami-v2';

export interface HfTokenResult {
  name: string;
}

/**
 * Validates a HuggingFace access token the same way settings.py's _test_token did: a real GET
 * against whoami-v2 with the token as a bearer, resolving with the account name on success.
 * `baseUrl` is overridable only by tests — production always hits the real HuggingFace API.
 */
export async function testHfToken(token: string, options: { baseUrl?: string; timeoutMs?: number } = {}): Promise<HfTokenResult> {
  const trimmed = (token ?? '').trim();
  if (!trimmed) throw new Error('Token vide.');
  const { baseUrl = REAL_ENDPOINT, timeoutMs = 8000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(baseUrl, { headers: { Authorization: `Bearer ${trimmed}` }, signal: controller.signal });
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error(`Délai dépassé (>${timeoutMs / 1000}s)`);
      throw new Error(error instanceof Error ? error.message : 'Erreur réseau');
    }
    if (!response.ok) throw new Error(`Token invalide : HTTP ${response.status}`);
    let info: unknown;
    try { info = await response.json(); }
    catch { throw new Error('Réponse inattendue du serveur HuggingFace'); }
    if (!info || typeof (info as any).name !== 'string') throw new Error('Réponse inattendue du serveur HuggingFace');
    return { name: (info as any).name };
  } finally {
    clearTimeout(timer);
  }
}
