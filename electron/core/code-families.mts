// Model families published as made for code. A short, honest list: every entry cites a page that was actually read
// (checkedOn), and the page must support the claim. A family absent from this list is not a bad one: it is `unknown`.
// Matching is on the repository id only, so a modified build (`abliterated`, `uncensored`) matches its base family
// and is neither boosted nor hidden.
// 'strong' is kept for a family whose own page claims leading results among open models on coding tasks;
// 'good' means the page only says the family is specialised for code.

export interface CodeFamily {
  match: RegExp;
  quality: 'strong' | 'good';
  source: string;
  checkedOn: string;
}

export const CODE_FAMILIES: CodeFamily[] = [
  // Page: "Agentic Coding" is a key feature, with a claimed significant performance among open models.
  { match: /qwen3[-_ .]?coder/i, quality: 'strong', source: 'https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct', checkedOn: '2026-11-09' },
  // Page: "Code-Specific Qwen large language models".
  { match: /qwen2\.5[-_ ]?coder/i, quality: 'good', source: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct', checkedOn: '2026-11-09' },
  // Page: "an open-source Mixture-of-Experts (MoE) code language model" (V2 Lite page; the family name covers V1 too).
  { match: /deepseek[-_ ]?coder/i, quality: 'good', source: 'https://huggingface.co/deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct', checkedOn: '2026-11-09' },
  // Page: "an agentic LLM for software engineering tasks".
  { match: /devstral/i, quality: 'good', source: 'https://huggingface.co/mistralai/Devstral-Small-2507', checkedOn: '2026-11-09' },
];
