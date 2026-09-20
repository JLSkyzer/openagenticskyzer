import { Markdown } from '../markdown/Markdown';

// Styles copied from chat.py::_render_message: user bubble bg-indigo-950/text-purple-200
// right-aligned, AI bubble bg #1a1a1a with a square top-left corner (border-radius:
// 2px 10px 10px 10px) and a purple avatar circle.
//
// `onFork` is only passed while no agent is running (chat.py hides the whole action row then,
// rather than greying it out): the ⑂ button is absent, not disabled.
export function UserBubble({ content, onFork }: { content: string; onFork?: () => void }) {
  return (
    <div className="group flex flex-col items-end gap-1 px-4 py-1">
      <div
        data-testid="oa-user-bubble"
        className="max-w-xl whitespace-pre-wrap rounded-lg bg-indigo-950 px-3 py-2 text-xs text-purple-200"
      >
        {content}
      </div>
      {onFork && (
        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            data-testid="oa-fork-btn"
            title="Créer une branche depuis ici"
            aria-label="Créer une branche depuis ici"
            onClick={onFork}
            className="h-6 w-6 rounded bg-gray-800 text-xs text-gray-400 hover:text-purple-400"
          >
            ⑂
          </button>
        </div>
      )}
    </div>
  );
}

export function AssistantBubble({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className="flex gap-2 px-4 py-1">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-purple-600 text-[10px] font-bold text-white">
        AI
      </div>
      <div
        className="max-w-3xl flex-1 bg-[#1a1a1a] px-3 py-2 text-xs text-gray-200"
        style={{ borderRadius: '2px 10px 10px 10px' }}
        data-testid="oa-assistant-bubble"
      >
        <Markdown>{content}</Markdown>
        {streaming && <span className="oa-typing-caret" aria-hidden="true" />}
      </div>
    </div>
  );
}
