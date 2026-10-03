# Agent core audit: Python (HEAD) vs Node/Electron port

Read-only audit, 2026-10-03. Python is read from `git show HEAD:` (the local uncommitted diffs in `agent.py` (1 line) and `app/main.py` do not touch the agent loop). Node is read from the working tree.

The Python GUI path that was audited is `app/components/input_bar.py::_send_message` → `agent.build_agent` → `graph/workflow.build_graph` → `graph/nodes.*` + `permissions.make_permission_tool_node`. The Node path is `worker.mjs::runSend` → `core/agent.mts::runAgent` → `core/provider.mts` / `core/local-engine.mts`.

Counts: **High 5 · Medium 12 · Low 6**

---

## High

### H1. Every response is capped at `reserved_tokens` (2048 by default), and a capped response fails the turn
- **Python:** `utils/utils.py:663-791` sets the output cap per provider: 16 384 (together, mistral, gemini, openrouter), 8 192 (groq, lmstudio, llamacpp), none (ollama). `reserved_tokens` is only subtracted from the context budget used for history trimming (`input_bar.py:246-249`). Its UI label says so: "Tokens réservés pour la réponse / Espace toujours gardé libre pour la génération" (`settings.py:245-248`). A truncated response is accepted as is.
- **Node:** `agent.mts:75` sends `maxTokens: settings.reserved_tokens`, which `provider.mts:52` turns into `body.max_tokens`. The default is 2048 (`settings.mts:6`). Then `provider.mts:74-75` treats any `finish_reason` other than stop/tool_calls (so `length` too) as a thrown error: "Réponse interrompue par le provider : limite ou filtre". The local engine also gets `maxTokens` = `reserved_tokens` (`worker.mjs:309`, `local-engine.mts:85`).
- **Scenario:** a user asks for a 300-line component. The `create_file` arguments (tool-call arguments count toward `max_tokens`) or a long explanation go past about 2048 tokens. With a remote provider the whole turn ends in an error. The partially streamed text is not saved (`worker.mjs:368` keeps the partial text only on abort). Python wrote the file. A "thinking" model that spends tokens on reasoning hits the cap even sooner (assumption, not tested).
- **Severity:** High: the agent fails tasks Python handled. **Confidence:** both sides read fully. **Known/deliberate?** No.

### H2. Step limit is 24 model calls, against about 150 in Python
- **Python:** `input_bar.py:115` uses `recursion_limit: 300` graph steps. One round is agent + tools = 2 steps, plus the reasoning node, so about 149 LLM calls. Hitting the limit shows "❌ Erreur : …recursion…" (`input_bar.py:506`; the CLI has a dedicated message at `agent.py:122-123`).
- **Node:** `agent.mts:53` defaults `maxSteps` to 24. `worker.mjs:356-360` never passes it, and nothing makes it configurable (`grep maxSteps` matches only `agent.mts` and tests). At the limit it shows "Limite de tours atteinte. La génération a été arrêtée." (`agent.mts:112`). The transcript is saved (`worker.mjs:375`).
- **Scenario:** scaffolding a small project with about 15 files, plus reads, `create_dir` per folder level (see M2), plus a build command, is more than 24 rounds for a model that makes one call per response (most local models). Node stops halfway; Python finished.
- **Severity:** High. **Confidence:** full. **Known/deliberate?** No.

### H3. No history trimming at all, tool outputs and attachments kept across turns, and a context gauge that ignores them: context overflow ends in an opaque 400
- **Python:** before each LLM call, `nodes.py:397` runs `trim_message_history` (`context/messages.py:22-72`). It keeps the last 20 messages and fits a token budget of `ctx_limit - reserved_tokens` (`input_bar.py:246-249`), counting tool messages too. Across turns only user/assistant text is sent (`input_bar.py:274-278`): no earlier tool outputs, no earlier attachments.
- **Node:** `worker.mjs:334-337` sends the whole saved transcript, and `agent.mts:56` adds no trimming at all, inside a turn or across turns. That transcript includes every tool call and result (up to 50 000 characters each, `agent.mts:107`) and every earlier attachment, which `toWireMessage` re-expands on every turn (`attachments.mts:70-74`). The renderer's gauge counts user/assistant text only (`renderer-src/src/state/context.ts:32-42`; the comment admits it underestimates), so auto-compaction does not trigger.
- **Scenario:** a 32k-context provider (ollama, lmstudio, mistral) after 3 or 4 `read_file` calls of 40 KB, or after attaching a PDF once. Every later send is rejected by the provider while the gauge shows a few percent. The user sees only "Erreur du provider (400)." (see M9). Python kept working (and dropped old context). One trade-off in Node's favour: Python's 20-message cut could drop the user's own request during long tool loops.
- **Severity:** High: the agent fails tasks Python handled. **Confidence:** full on both sides. Not checked: whether node-llama-cpp's default context shift saves the local GGUF case.

### H4. A Stop during a tool run or a permission prompt leaves a dangling `tool_calls` message, which can break the conversation for strict providers
- **Python:** history across turns is text only (`input_bar.py:274-278`), so an interrupted tool call can never reach a later request.
- **Node:** on abort, `agent.mts:96-105` re-throws before pushing the `tool` result. The assistant message carrying `tool_calls` was already emitted and accumulated (`agent.mts:79`, `worker.mjs:341-344`), and `worker.mjs:375` saves it. Nothing repairs it on reload (`conversations.mts`, `agent.mts:56`). The renderer's own comment confirms that no event follows for that call (`reducer.ts:235-238`).
- **Scenario:** the user clicks Stop while the permission banner for `run_command` is open (or during a long command, or after the first of two calls). Every later message sends `assistant{tool_calls}` with no matching `tool` message. OpenAI-compatible APIs that enforce this pairing return 400. I took that rejection from provider documentation (OpenAI, Groq, Mistral); I did not run it here. The conversation stays broken until the user edits or regenerates an earlier message, clears it, or compacts it. The manual compact button only shows above the threshold, which the gauge does not reach (H3).
- **Severity:** High: the conversation is unusable afterwards. **Confidence:** Node path read fully; provider behaviour from documentation. **Known/deliberate?** No.

### H5. In "demander" mode, file/git/memory writes no longer ask by default, and "Toujours" becomes a persistent, category-wide grant
- **Python:** `permissions.py:73-90` asks in "demander" mode for every tool not in `_READ_ONLY_TOOLS`: create/edit/delete file and dir, `git_add`/`commit`/`checkout`/`stash`/…, `save_memory`, `forget_memory`. The `files_ask`/`shell_ask`/`search_ask` switches exist (`storage.py:83-85`, `settings.py:297-307`) but `PermissionManager` never reads them. "Toujours" adds one tool name to a set that lives as long as the `PermissionManager`, and `input_bar.py:251-255` creates a new one on every send. So it lasts one turn.
- **Node:** `agent.mts:40` allows the whole `write` category when `files_ask === false`, and that is the default (`settings.mts:8`). The category includes `edit_file` (overwrites in place, no trash), `git_add`/`commit`/`checkout`/`create_branch`/`stash`/`stash_pop` (`git-tools.mts:126-149`), and `save_memory`/`forget_memory` (`memory-tools.mts:100,130`). "Toujours" on any write or network tool saves `files_ask:false` / `search_ask:false` permanently for the project (`worker.mjs:505-509`). The banner just says "Toujours" (`PermissionBanner.tsx:49`).
- **Scenario:**
  - A fetched web page carrying an injection can make the agent `save_memory` a poisoned instruction. Memory is re-injected into the system prompt on every turn (`context.mts:30-33`). In Node no prompt appears; in Python a prompt appeared.
  - The agent can `git_commit` or `forget_memory` silently.
  - Clicking "Toujours" once on `create_file` permanently allows `git_checkout`/`git_stash` for that project.
- Note: Node honours a setting that Python displayed but ignored, so this may be intended. It is still a real change in what runs without confirmation, and the git and memory tools go beyond the switch label ("Écriture / suppression de fichiers").
- **Severity:** High (permission difference). **Confidence:** full. **Known/deliberate?** Not in the list. Probably semi-deliberate, so worth an explicit decision.

---

## Medium

### M1. Invalid tool arguments are refused with no detail, and validation is stricter than Python's
- **Python:** LangChain/pydantic coerces `"60"`→60, ignores extra keys, and a validation failure comes back as `[Erreur] tool: <pydantic message>` (`permissions.py:159-166`), which the model can fix.
- **Node:** `agent.mts:93-94` replaces every parse or validation error with "Arguments outil invalides : exécution refusée". `tool-kit.mts:28-32,48-55` refuses unknown keys (`additionalProperties:false`), strings for integers, integers below 1 by default (`read_file` `offset:0`) and values above the max (`run_command` timeout > 600, `max_results` > 20).
- **Scenario:** a local model sends `{"command":"npm test","timeout":"120"}` or adds an undeclared `encoding` key. Node refuses without saying which field is wrong, so the model often retries the same call. That hits the ×3 loop guard and burns steps out of 24. Python ran the call.
- **Severity:** Medium. **Confidence:** full.

### M2. `create_file` cannot overwrite and does not create parent folders; `create_dir` is not recursive; the Next.js gate asks for an impossible action
- **Python:** `crud_tools.py:55-75` overwrites and runs `makedirs(parent)`. `create_dir` uses `makedirs(exist_ok=True)` (`:226-236`). The loop detector advises "rewrite the entire file with create_file" (`loop_detector.py:58-62`).
- **Node:** `workspace.mts:111-118` opens with `'wx'` (fails if the file exists) and needs an existing parent. `create_dir` is a plain `mkdir` (`:134-136`). Yet `shell-tool.mts:126-130` still answers "BLOCKED … Call create_file('app/page.tsx', <full page content>) now", and `page.tsx` always exists at that point.
- **Scenario:** "rewrite `src/utils/api.ts`" or "create `src/components/Header.tsx`" in a fresh repo. Node returns raw `EEXIST`/`ENOENT` errors, then needs `delete_file`+`create_file` or one `create_dir` per level, all under the 24-step cap (H2). The Next.js flow cannot follow its own instruction.
- **Severity:** Medium. **Confidence:** full. **Known/deliberate?** The parent rule is commented as deliberate; it is not in the list.

### M3. `read_file` truncates silently
- **Python:** `crud_tools.py:105-145` reads the whole file up to 100 000 characters, adds a "Showing lines X-Y of N" header when partial, and a "[truncated — showing a/b lines]" marker.
- **Node:** `workspace.mts:95-100` returns at most 1000 lines by default (`limit ?? 1000`), then `.slice(0, 50000)`, with no header and no marker. The generic 50 000 marker in `agent.mts:107` never fires because the output is already exactly 50 000 or less.
- **Scenario:** a 2500-line file. The model believes it ends at line 1000, then analyses or edits the wrong thing.
- **Severity:** Medium. **Confidence:** full.

### M4. Tool calls a model writes as text are not recovered for HTTP providers
- **Python:** `nodes.py:39-60,431` (`_coerce_text_tool_call`, for every provider) turns `{"name":…,"arguments":…}` written in the text into real tool calls.
- **Node:** absent from `provider.mts`. The node-llama-cpp GGUF path does not need it (grammar-constrained function calls).
- **Scenario:** an Ollama, LM Studio or llama.cpp-server model whose template does not emit native tool calls. Node shows the raw JSON as the final answer and ends the turn; Python executed the call.
- **Severity:** Medium (local HTTP providers). **Confidence:** full.

### M5. Local models are no longer forced to search the web, and the prompt no longer requires searching
- **Python:** for local providers, `nodes.py:301-362,432-433` replaces a "I can't search the web" refusal, or a from-memory answer to a recent-fact question (years 2024-2029, "who won", "champion"…), with a forced `internet_search` call. `prompts/prompt.py:5-16` also makes search mandatory for such questions.
- **Node:** none of this. `BASE_SYSTEM_PROMPT` (`worker.mjs:106-113`) only lists the tools.
- **Scenario:** "qui a remporté la Ligue des champions 2025 ?" on a local model. Node answers from memory, or refuses; Python searched.
- **Severity:** Medium. **Confidence:** full. **Known/deliberate?** Separate from known #4: #4 is the `input_bar.py` pre-fetch, while this is the `nodes.py` post-response forcing plus the prompt rule.

### M6. No mode instruction: "plan" behaves like "ask", and in ask/plan the prompt advertises write tools the model does not have
- **Python:** `agent.py:75-84` appends `mode_router(mode)` (`utils.py:64-73`). Plan mode says: "First produce a detailed step-by-step plan and wait for user approval". Ask mode says: "Do NOT modify any files…".
- **Node:** nothing tells the model the mode. `BASE_SYSTEM_PROMPT` (`worker.mjs:106-113`) always lists `create_file`, `edit_file`, `run_command`, `git_commit`. In ask/plan, only read schemas are sent (`agent.mts:62`).
- **Scenario:** in plan mode the user gets an ordinary answer, not a plan. A local model may call `create_file`, which is denied with "Exécution refusée par les permissions" and costs steps.
- **Severity:** Medium. **Confidence:** full. **Known/deliberate?** The read-only part is known #1; the missing instruction and the contradictory prompt are not.

### M7. The model is not told it runs under Windows cmd.exe
- **Python:** `prompt.py:58-62`: "WINDOWS (cmd, not PowerShell): Forbidden: head, tail, grep, cat, touch…", plus "use findstr", `curl -o nul`.
- **Node:** `run_command` uses `shell:true` (cmd.exe) with `chcp 65001` (`shell-tool.mts:165,172`), and neither the base prompt nor the tool description mentions the OS or the shell.
- **Scenario:** the model runs `cat package.json | grep version` or `ls -la`. It fails, retries, and burns steps.
- **Severity:** Medium. **Confidence:** full.

### M8. No retry on transient provider errors, and a hard 300 s cap per model call
- **Python:** `ChatOpenAI` (openrouter, lmstudio, llamacpp) inherits openai SDK `DEFAULT_MAX_RETRIES = 2`, verified with the installed `langchain_openai` (`max_retries` default None) and `openai` 2. It retries on 408/409/429/5xx and connection errors. Other LangChain clients have their own defaults; not verified because they are not installed. The SDK timeout is per network operation, so a long stream is not killed.
- **Node:** `provider.mts:46` uses `AbortSignal.timeout(300000)` on the whole streamed response, and nothing retries anywhere. `retryAfter` is parsed (`provider.mts:36`) but never used.
- **Scenarios:**
  - A single 502 or 429 from OpenRouter fails the whole turn.
  - A CPU-bound Ollama model generating at about 3 tokens/s for more than 5 minutes is aborted: the error is TimeoutError, not AbortError, so `worker.mjs:364` reports an error and the partial text is lost.
- **Severity:** Medium. **Confidence:** Node full; Python partial (library defaults).

### M9. Provider error details are thrown away
- **Python:** `input_bar.py:490-506` shows `str(exc)`, which includes the server's message ("context length exceeded", "tool_call_ids did not have response messages"…). It has a dedicated help message for LM Studio Jinja/tool-template errors.
- **Node:** `provider.mts:56-58` cancels the body and throws `ProviderError`, which gives only "Erreur du provider (400)." (`provider.mts:34`). A stream error chunk becomes a generic message (`:71`).
- **Scenario:** in H3, H4 and M10 the user cannot tell what went wrong or what to do.
- **Severity:** Medium (UX; it hides the cause of the High issues). **Confidence:** full.

### M10. The LM Studio system-prompt merge (`lmstudio_compat`) was not ported
- **Python:** `nodes.py:408-421` (enabled by `agent.py:89` when provider == lmstudio) folds the system prompt into the first user message. This works around LM Studio Jinja templates that cannot place tools when the first message is not from the user.
- **Node:** absent. `agent.mts:56` always sends `{role:'system'}` first, and no code branches on `connection.provider`.
- **Scenario:** an LM Studio model with an affected template fails on every message with "Erreur du provider (400)." (M9 hides the "jinja" hint).
- **Severity:** Medium (only affected models). **Confidence:** Node full; which models are affected was not tested.

### M11. Local servers are not started and models are not pulled automatically
- **Python:** `get_llm` runs `_ensure_ollama_server` (`ollama serve`, then `ollama pull <model>` if missing, `utils.py:566-604`), `_ensure_lmstudio_server` (`lms server start`) and `lms load`, and starts `llama_cpp.server` for llamacpp (`:381-422`).
- **Node:** nothing does this. `grep` finds no serve/pull/lms code in `electron/`. Only the in-process GGUF engine loads by itself.
- **Scenario:** a user with Ollama installed but not running, or a model not yet pulled, gets a fetch error on the first message. With the llamacpp provider, nothing will ever answer on :8080.
- **Severity:** Medium. **Confidence:** full. **Known/deliberate?** Possibly partly deliberate (in-process GGUF replaces llamacpp); not in the list.

### M12. Local GGUF tool-call ids restart after each app launch and collide with older ones in the history
- **Python:** n/a (LangChain/llama-cpp-server ids).
- **Node:** `local-engine.mts:69,87` mints `local-${++mintedIds}`, and the counter resets with each worker process. `local-provider.mts:46-47` maps results by id over the WHOLE history (`Map.set`, last one wins).
- **Scenario:** a conversation with a local model, then an app restart, then new tool calls `local-1`, `local-2`… The earlier `local-1` call in the history is now shown to the model with the NEW call's result. The model sees corrupted history.
- **Severity:** Medium (wrong data shown to the model). **Confidence:** full.

---

## Low

- **L1. The forced-file-creation hack is not ported** (`nodes.py:155-253`). For local providers, Python replaced a text answer to a "crée un fichier" request with `create_file('AppExemple.<ext>', <canned Java Swing template or placeholder>)`. Node has nothing. Its absence is an improvement. Confidence full.
- **L2. Node's strict mode blocks the web.** Python's strict allow-list includes `internet_search`/`fetch_url` (`permissions.py:20-27`). Node strict allows only the `read` category, and web tools are `network` (`agent.mts:38`). Node is more restrictive. Confidence full.
- **L3. `internet_search` with topic="news" no longer does a news search without Tavily.** Python DDG used `ddgs.news` (`internet_search.py:21-26`); Node DDG ignores `topic` (`web-tools.mts:271-311`). Confidence full.
- **L4. `edit_file` with an ambiguous string is refused** (`workspace.mts:122`). Python replaced the first occurrence (`crud_tools.py:163`). Safer, but it costs a step. Confidence full.
- **L5. An empty answer from the model is an error.** Node throws "Réponse vide du provider" (`provider.mts:118`); Python ended the turn silently. Confidence full.
- **L6. One malformed historical tool call breaks every turn after switching to a local GGUF model.** `historyFromMessages` runs `JSON.parse(call.function.arguments)` on the whole history (`local-provider.mts:57`). The saved transcript keeps calls that Node had rejected as "Arguments outil invalides". Confidence full; rare.

---

## Verified equivalent (or Node equal or better)

- **System-context assembly:** OPENAGENT.md, then CLAUDE.md, first found, 8000-character cap, an empty file stops the search; custom_prompt 8000; global then project memory, tail 4000 each; confirmed learnings, project first, deduplicated by id, max 20, 6000; global 20 000 cap; prefix placed before the static prompt. `system_context.py` / `project_instructions.py` / `learnings.py` match `context.mts:6-54`. Minor differences only (tags dropped, fields cut at 500).
- **System messages in stored history** are dropped before the call (`messages.py:41` vs `agent.mts:56`).
- **Unknown tool, denied tool, tool exception:** fed back to the model as a tool message and the loop continues (`permissions.py:143-166` vs `agent.mts:85-106`).
- **Malformed JSON arguments:** Node is better. It sends an error back to the model; Python LangChain moves the call to `invalid_tool_calls` and ends the turn.
- **Loop detection:** known #2. Python soft-warns on the 3rd identical call; Node refuses the 4th. Not worse than described.
- **Ask/plan read-only tool surface:** known #1, as described.
- **`run_command` output shaping:** noise collapse, 3000-character head/tail, HTML/JSON blob shortening, `[exit code]`, `[cwd]` and the dev-server background launch are a faithful port (`shell_exec.py:280-314` vs `shell-tool.mts:18-50`). Node adds secret scrubbing, a tree kill and a 1 MiB cap. The absolute-path rewrite (`_normalize_paths`) was dropped, which is cosmetic.
- **`fetch_url`:** default 4000 characters, truncation marker. Equivalent.
- **Cancellation:** Node is better. Abort reaches a pending permission (`agent.mts:27-35`) and kills process trees. In Python a Stop during a permission wait leaves a thread blocked on `req.wait()` forever (`permissions.py:117` with `input_bar.py:514` clearing only the UI side).
- **Compaction:** same prompt, 800 characters per message, user/assistant only, no tools, ≥6 messages; Node keeps a clean tail from the last user message. Equivalent or better.
- **Complexity routing (`complexity.py` + reasoning/critique nodes), absent in Node: not a loss.** Python's CoT and correction reach the graph state as `SystemMessage`s, and `trim_message_history` strips every `SystemMessage` before the agent call (`messages.py:41`, `nodes.py:397`). So the agent model never sees them. Their only effects are 1 or 2 extra LLM calls per "complex/critical" message, a possible re-run of the agent after the critique (which may repeat tool side effects), and probably CoT/critique text leaking into the streamed answer: `_stream_agent` collects every `on_chat_model_stream` without filtering by node (`input_bar.py:121-131`). That last point was inferred, not executed.
- **Local GGUF function calling:** node-llama-cpp grammar-constrained calls instead of Python's chatml llama.cpp server plus text coercion. Equal or better for the in-process path.
- **Streaming:** Node keeps every intermediate assistant message. Python discarded intermediate text at each tool start (`input_bar.py:145`) and stripped tool-output echoes with regexes (`:442-455`, absent in Node, cosmetic).

## Not covered

- Python tool modules beyond `crud_tools`, `shell_exec`, `web_fetch`, `internet_search`: `git_tools`, `memory_tools`, `index_tools` (semantic/knowledge search), the `mcp_client` adapter in detail, and plugins (known #5). Only their permission categories were compared.
- Behaviour of real providers. Rejection of dangling `tool_calls`, LM Studio template failures, Ollama `/v1` `finish_reason` values and node-llama-cpp context shift on overflow come from documentation or assumption; nothing was executed.
- `main.cjs` send/permission plumbing beyond the worker contract, and the renderer's display of errors in detail.
- Retry defaults of `langchain_groq`, `langchain_mistralai`, `langchain_google_genai` and `langchain_together`: not installed, and the project `.venv` is broken (it points to a missing Python 3.11).
