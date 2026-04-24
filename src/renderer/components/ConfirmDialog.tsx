import { useCallback, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertIcon } from './icons.js';

export type ConfirmState = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmState | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  if (!state) return null;

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await state.onConfirm();
      onClose();
    } catch {
      // caller is expected to handle errors (toast/etc) — just close
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    // Controlled shadcn Dialog — `open` follows the presence of state;
    // onOpenChange is invoked when the user clicks the backdrop, hits
    // Escape, or clicks the built-in close X. The overlay + content
    // already carry the glass-strong animations from the primitive.
    <Dialog
      open={true}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {state.danger && (
              <span
                className="flex size-7 items-center justify-center rounded-lg border border-red-500/30 bg-red-500/15 text-red-300"
                aria-hidden
              >
                <AlertIcon />
              </span>
            )}
            {state.title}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground leading-relaxed">
            {state.message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={state.danger ? 'destructive' : 'default'}
            onClick={() => void handleConfirm()}
            disabled={busy}
            autoFocus
          >
            {busy ? 'Working…' : state.confirmLabel ?? 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Tiny hook that pairs a ConfirmState with its rendered ConfirmDialog.
 * Every component that had its own `useState<ConfirmState | null>` +
 * `<ConfirmDialog state={...} onClose={...} />` boilerplate (jobs table,
 * accounts, logs, dashboard) now calls this and drops the ~10 lines.
 *
 *   const { confirm, dialog } = useConfirm();
 *   confirm({ title, message, onConfirm });
 *   return <>...{dialog}</>;
 *
 * Behavior matches the original pattern exactly: one active prompt at a
 * time, auto-closes after onConfirm resolves (or throws — caller toasts
 * errors), backdrop/Escape dismisses when not busy.
 */
export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);
  const confirm = useCallback((s: ConfirmState) => setState(s), []);
  const dialog = <ConfirmDialog state={state} onClose={() => setState(null)} />;
  return { confirm, dialog };
}
