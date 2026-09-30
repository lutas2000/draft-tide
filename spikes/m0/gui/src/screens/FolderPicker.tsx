import { useState } from 'react';
import { Folder } from '../components/Icons';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { cn } from '../lib/cn';
import type { FolderChoice } from '../mock/types';

/**
 * Stand-in for the native folder dialog (Electron Main owns it in the product).
 * Choosing a folder only grants read access for the scope review.
 */
export function FolderPicker({
  open,
  title,
  choices,
  confirmLabel,
  onCancel,
  onChoose,
  validate,
  hint,
}: {
  open: boolean;
  title: string;
  choices: readonly FolderChoice[];
  confirmLabel: string;
  onCancel: () => void;
  onChoose: (c: FolderChoice) => void;
  validate?: (c: FolderChoice) => string | null;
  hint?: string;
}) {
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const choice = choices[selected];
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      simulated="原型：模擬系統的資料夾選擇視窗"
      size="sm"
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button
            variant="primary"
            disabled={!choice}
            onClick={() => {
              if (!choice) return;
              const problem = validate?.(choice) ?? null;
              setError(problem);
              if (!problem) onChoose(choice);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {hint && <p className="mb-3 text-[13px] text-ink-2">{hint}</p>}
      <div role="radiogroup" aria-label="資料夾" className="flex flex-col gap-1.5">
        {choices.map((c, i) => (
          <button
            key={c.displayPath}
            type="button"
            role="radio"
            aria-checked={i === selected}
            data-autofocus={i === selected ? '' : undefined}
            onClick={() => {
              setSelected(i);
              setError(null);
            }}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left',
              i === selected ? 'border-tide-500 bg-tide-50' : 'border-line hover:bg-raised',
            )}
          >
            <Folder className="size-5 text-tide-600" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{c.displayPath}</span>
              <span className="block text-[12px] text-ink-3">{c.note}</span>
            </span>
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
