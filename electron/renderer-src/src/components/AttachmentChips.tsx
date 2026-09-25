import { attachmentIcon } from '../state/upload';
import type { Attachment } from '../ipc/bridge';

// input_bar.py::_attachments_display: what is about to be sent, above the hint line. An image is a 72×72 thumbnail
// with a round ✕; anything else is a 90×72 card with an icon by extension and the (truncated) name.
export function AttachmentChips({ attachments, onRemove }: { attachments: readonly Attachment[]; onRemove(index: number): void }) {
  if (attachments.length === 0) return null;
  return (
    <div data-testid="oa-attachments" className="flex flex-wrap gap-2 px-1 pb-1">
      {attachments.map((attachment, index) => {
        const remove = (
          <button
            type="button"
            data-testid="oa-attachment-remove"
            title={`Retirer ${attachment.name}`}
            aria-label={`Retirer ${attachment.name}`}
            onClick={() => onRemove(index)}
            className="absolute right-0.5 top-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] leading-none text-white"
            style={{ background: 'rgba(0,0,0,.7)' }}
          >
            ✕
          </button>
        );
        if (attachment.content_type === 'image') {
          return (
            <div
              key={index}
              data-testid="oa-attachment-chip"
              data-kind="image"
              className="relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-lg"
              style={{ border: '1px solid #3a3a3a' }}
            >
              <img src={attachment.content} alt={attachment.name} title={attachment.name} className="block h-[72px] w-[72px] object-cover" />
              {remove}
            </div>
          );
        }
        return (
          <div
            key={index}
            data-testid="oa-attachment-chip"
            data-kind="file"
            className="relative flex h-[72px] w-[90px] shrink-0 flex-col justify-between rounded-lg px-2 py-1.5"
            style={{ background: '#1e1e2e', border: '1px solid #3a3a3a' }}
          >
            <span className="text-[22px] leading-none">{attachmentIcon(attachment.name)}</span>
            <span className="max-w-[74px] truncate text-[9px]" style={{ color: '#aaa' }} title={attachment.name}>{attachment.name}</span>
            {remove}
          </div>
        );
      })}
    </div>
  );
}
