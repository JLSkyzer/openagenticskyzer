import { Markdown } from '../markdown/Markdown';
import type { Attachment } from '../ipc/bridge';
import { attachmentIcon } from '../state/upload';

// Styles copied from chat.py::_render_message: user bubble bg-indigo-950/text-purple-200
// right-aligned, AI bubble bg #1a1a1a with a square top-left corner (border-radius:
// 2px 10px 10px 10px) and a purple avatar circle.
//
// `onFork` is only passed while no agent is running (chat.py hides the whole action row then,
// rather than greying it out): the ⑂ button is absent, not disabled.
export function UserBubble({ content, attachments, onFork, onEdit }: { content: string; attachments?: readonly Attachment[]; onFork?: () => void; onEdit?: () => void }) {
  const images = attachments?.filter(attachment => attachment.content_type === 'image') ?? [];
  const files = attachments?.filter(attachment => attachment.content_type !== 'image') ?? [];
  return (
    <div className="group flex flex-col items-end gap-1 px-4 py-1">
      {/* chat.py: the images sent with a message are shown above it (220×160 at most). Other files are named —
          the original showed nothing for them, so a reloaded conversation gave no hint of what the model had read. */}
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((image, index) => (
            <img
              key={index}
              data-testid="oa-message-image"
              src={image.content}
              alt={image.name}
              title={image.name}
              className="block rounded-lg object-cover"
              style={{ maxWidth: 220, maxHeight: 160 }}
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1">
          {files.map((file, index) => (
            <span key={index} data-testid="oa-message-file" className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400" title={file.name}>
              {attachmentIcon(file.name)} {file.name}
            </span>
          ))}
        </div>
      )}
      <div
        data-testid="oa-user-bubble"
        className="max-w-xl whitespace-pre-wrap rounded-lg bg-indigo-950 px-3 py-2 text-xs text-purple-200"
      >
        {content}
      </div>
      {(onEdit || onFork) && (
        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {onEdit && (
            <button
              type="button"
              data-testid="oa-edit-btn"
              title="Éditer ce message"
              aria-label="Éditer ce message"
              onClick={onEdit}
              className="h-6 w-6 rounded bg-gray-800 text-xs text-gray-400 hover:text-white"
            >
              ✏️
            </button>
          )}
          {onFork && (
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
          )}
        </div>
      )}
    </div>
  );
}

// `onRegenerate` is only passed for the last reply while nothing is running (chat.py: `is_last_ai and not
// state.agent_running`): the 🔄 button is absent, not disabled.
export function AssistantBubble({ content, streaming = false, onRegenerate }: { content: string; streaming?: boolean; onRegenerate?: () => void }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-1">
      <div className="flex gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-purple-600 text-[10px] font-bold text-white">
          AI
        </div>
        <div
          className="min-w-0 max-w-3xl flex-1 bg-[#1a1a1a] px-3 py-2 text-xs text-gray-200"
          style={{ borderRadius: '2px 10px 10px 10px' }}
          data-testid="oa-assistant-bubble"
        >
          <Markdown>{content}</Markdown>
          {streaming && <span className="oa-typing-caret" aria-hidden="true" />}
        </div>
      </div>
      {onRegenerate && (
        <button
          type="button"
          data-testid="oa-regenerate-btn"
          title="Régénérer cette réponse"
          aria-label="Régénérer cette réponse"
          onClick={onRegenerate}
          className="ml-9 w-fit bg-transparent text-xs text-gray-500 hover:text-purple-400"
        >
          🔄
        </button>
      )}
    </div>
  );
}
