import { Markdown } from '../markdown/Markdown';

// Styles copied from chat.py::_render_message: user bubble bg-indigo-950/text-purple-200
// right-aligned, AI bubble bg #1a1a1a with a square top-left corner (border-radius:
// 2px 10px 10px 10px) and a purple avatar circle.
export function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end px-4 py-1">
      <div className="max-w-xl whitespace-pre-wrap rounded-lg bg-indigo-950 px-3 py-2 text-xs text-purple-200">
        {content}
      </div>
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
