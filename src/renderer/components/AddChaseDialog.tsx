import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * Add-Chase dialog: collects label + username + password in one go,
 * saves the profile + encrypted credentials atomically (caller handles
 * the IPC), then triggers the login flow which auto-fills using the
 * just-saved credentials. First-time users see a Chase window pop up
 * already pre-filled and submitted; they only need to clear OTP (if
 * Chase challenges) and click into their Amazon credit card to
 * complete the link.
 *
 * Why credentials are required (not optional): the whole point of
 * this app's Chase integration is automated re-auth on session
 * expiration. Without saved creds the bot can't recover, the user
 * has to manually re-login every few hours. Forcing them in at
 * add-time avoids the "I added a profile but forgot creds" failure
 * mode where automation silently fails later.
 */
export function AddChaseDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (label: string, credentials: { username: string; password: string }) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLabel('');
    setUsername('');
    setPassword('');
    setBusy(false);
    setError(null);
  };

  const canSubmit =
    label.trim().length > 0 &&
    username.trim().length > 0 &&
    password.length > 0 &&
    !busy;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(label.trim(), {
        username: username.trim(),
        password,
      });
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // never lose state mid-submit
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Chase account</DialogTitle>
          <DialogDescription>
            AmazonG saves your Chase credentials locally (encrypted via macOS
            Keychain) so it can sign you back in automatically when the
            session expires. The plaintext password never leaves your laptop.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="add-chase-label"
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              Account name
            </label>
            <input
              id="add-chase-label"
              type="text"
              placeholder="e.g. Personal, Business, Mom"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
              autoFocus
              className="h-9 rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm text-foreground/90 disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="add-chase-username"
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              Chase username
            </label>
            <input
              id="add-chase-username"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
              className="h-9 rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm text-foreground/90 disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="add-chase-password"
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              Chase password
            </label>
            <input
              id="add-chase-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void handleSubmit();
              }}
              className="h-9 rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm text-foreground/90 disabled:opacity-50"
            />
          </div>

          <div className="text-[11px] text-muted-foreground italic">
            After Add, AmazonG opens a Chase window, fills these credentials,
            and ticks &quot;Use token&quot; / &quot;Remember me&quot;. If Chase
            asks for an OTP (likely on the first add), enter it in the window
            — then click into your Amazon credit card and the window closes
            itself.
          </div>

          {error && (
            <div className="text-[11px] text-red-300 break-all">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
