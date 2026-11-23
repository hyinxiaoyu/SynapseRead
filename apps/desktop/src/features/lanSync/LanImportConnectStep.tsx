import { Loader2, ShieldAlert } from 'lucide-react';
import { type FormEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describeLanError } from '@/features/lanSync/lanSyncCopy';
import { useStudySyncStore } from '@/stores/useStudySyncStore';

const AUTO_RETRY_DELAY_MS = 250;

export interface LanImportConnectController {
  address: string;
  code: string;
  validationError: string | null;
  isAutoRetrying: boolean;
  isBusy: boolean;
  handleAddressChange: (next: string) => void;
  handleCodeChange: (next: string) => void;
  submit: () => Promise<void>;
  cancel: () => void;
}

export function useLanImportConnect(): LanImportConnectController {
  const phase = useStudySyncStore((state) => state.lanImport.phase);
  const error = useStudySyncStore((state) => state.lanImport.error);
  const connectLanImport = useStudySyncStore((state) => state.connectLanImport);
  const cancelLanImportOperation = useStudySyncStore((state) => state.cancelLanImportOperation);
  const clearLanImportError = useStudySyncStore((state) => state.clearLanImportError);

  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isAutoRetrying, setIsAutoRetrying] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const retryTimerRef = useRef<number | undefined>(undefined);
  const retryResolveRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);

  const settlePendingRetryWait = useCallback(() => {
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
    const resolve = retryResolveRef.current;
    retryResolveRef.current = null;
    resolve?.();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      settlePendingRetryWait();
    };
  }, [settlePendingRetryWait]);

  const handleAddressChange = useCallback(
    (next: string) => {
      setAddress(next);
      setValidationError(null);
      if (error !== null) {
        clearLanImportError();
      }
    },
    [clearLanImportError, error],
  );

  const handleCodeChange = useCallback(
    (next: string) => {
      setCode(next.replace(/\s+/g, ''));
      setValidationError(null);
      if (error !== null) {
        clearLanImportError();
      }
    },
    [clearLanImportError, error],
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    settlePendingRetryWait();
    setIsAutoRetrying(false);
    setIsSubmitting(false);
    void cancelLanImportOperation();
  }, [cancelLanImportOperation, settlePendingRetryWait]);

  const submit = useCallback(async () => {
    const trimmedAddress = address.trim();
    const cleanedCode = code.replace(/\s+/g, '');

    if (trimmedAddress.length === 0) {
      setValidationError(
        'Enter the source device IPv4 address (for example, 192.168.1.42 or 192.168.1.42:49319).',
      );
      return;
    }

    if (!/^\d{6}$/.test(cleanedCode)) {
      setValidationError('Enter the 6-digit pairing code shown on the source device.');
      return;
    }

    setValidationError(null);
    clearLanImportError();
    settlePendingRetryWait();
    cancelledRef.current = false;
    setIsAutoRetrying(false);
    setIsSubmitting(true);

    try {
      const session = await connectLanImport(trimmedAddress, cleanedCode);
      if (!mountedRef.current || cancelledRef.current || session !== null) {
        return;
      }

      const firstError = useStudySyncStore.getState().lanImport.error;
      if (firstError?.code !== 'lan_unreachable') {
        return;
      }

      // A single delayed retry smooths over transient mDNS/ARP wakeups on LAN,
      // while non-network errors (bad code, expired, incompatible, etc.) fail fast.
      setIsAutoRetrying(true);
      await new Promise<void>((resolve) => {
        retryResolveRef.current = resolve;
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = undefined;
          if (!mountedRef.current || cancelledRef.current) {
            if (retryResolveRef.current === resolve) {
              retryResolveRef.current = null;
            }
            resolve();
            return;
          }
          void connectLanImport(trimmedAddress, cleanedCode).finally(() => {
            if (mountedRef.current) {
              setIsAutoRetrying(false);
            }
            if (retryResolveRef.current === resolve) {
              retryResolveRef.current = null;
            }
            resolve();
          });
        }, AUTO_RETRY_DELAY_MS);
      });
    } finally {
      if (mountedRef.current) {
        setIsSubmitting(false);
      }
    }
  }, [address, clearLanImportError, code, connectLanImport, settlePendingRetryWait]);

  const isBusy = phase === 'connecting' || isSubmitting || isAutoRetrying;

  return {
    address,
    code,
    validationError,
    isAutoRetrying,
    isBusy,
    handleAddressChange,
    handleCodeChange,
    submit,
    cancel,
  };
}

export function LanImportConnectStep({
  controller,
  addressInputRef,
}: {
  controller: LanImportConnectController;
  addressInputRef: RefObject<HTMLInputElement | null>;
}) {
  const error = useStudySyncStore((state) => state.lanImport.error);
  const clearLanImportError = useStudySyncStore((state) => state.clearLanImportError);

  const errorPresentation = error && !controller.isAutoRetrying ? describeLanError(error) : null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!controller.isBusy) {
      void controller.submit();
    }
  };

  return (
    <form id="lan-import-connect-form" className="space-y-4 text-sm" onSubmit={handleSubmit}>
      <div
        role="note"
        data-testid="lan-import-trust-warning"
        className="flex items-start gap-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-xs text-amber-950 dark:text-amber-100"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-0.5">
          <p className="font-semibold">Only connect to a trusted device on your local network</p>
          <p>
            SynapseRead transfers books, reading positions, and bookmarks unencrypted over local
            Wi-Fi or Ethernet. Never enter a code from a device you do not control.
          </p>
        </div>
      </div>

      {controller.isAutoRetrying && (
        <div
          role="status"
          data-testid="lan-import-auto-retrying"
          className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-foreground"
        >
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          <span>Source device did not respond yet — retrying connection once…</span>
        </div>
      )}

      {controller.validationError && (
        <div
          role="alert"
          data-testid="lan-import-validation-error"
          className="rounded-md border border-red-600/40 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-900 dark:text-red-100"
        >
          {controller.validationError}
        </div>
      )}

      {errorPresentation && error && (
        <div
          role="alert"
          data-testid="lan-import-connect-error"
          data-error-code={error.code}
          className="space-y-2 rounded-md border border-red-600/40 bg-red-500/10 p-3 text-xs"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-red-900 dark:text-red-100">
              {errorPresentation.title}
            </p>
            <button
              type="button"
              className="text-foreground underline hover:opacity-80"
              onClick={clearLanImportError}
            >
              Dismiss
            </button>
          </div>
          <p className="text-foreground">{errorPresentation.detail}</p>
          {errorPresentation.hints.length > 0 && (
            <ul className="list-disc space-y-1 pl-4 text-foreground">
              {errorPresentation.hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          )}
          {errorPresentation.canRetry && (
            <div className="pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="lan-import-connect-retry"
                disabled={controller.isBusy}
                onClick={() => void controller.submit()}
              >
                Retry
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label
            htmlFor="lan-import-address-input"
            className="block text-xs font-medium text-foreground"
          >
            Source device address
          </label>
          <Input
            ref={addressInputRef}
            id="lan-import-address-input"
            data-testid="lan-import-address-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="192.168.1.42 or 192.168.1.42:49319"
            disabled={controller.isBusy}
            value={controller.address}
            onChange={(event) => controller.handleAddressChange(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Private IPv4 address (and optional port) shown in the other device&apos;s Share dialog.
          </p>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="lan-import-code-input"
            className="block text-xs font-medium text-foreground"
          >
            6-digit pairing code
          </label>
          <Input
            id="lan-import-code-input"
            data-testid="lan-import-code-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            className="font-mono tracking-widest"
            disabled={controller.isBusy}
            value={controller.code}
            onChange={(event) => controller.handleCodeChange(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Spaces are ignored automatically. Locks after 5 wrong attempts.
          </p>
        </div>
      </div>

      {/* Hidden submit button enables Enter-to-submit inside the form even though visible controls sit in the dialog footer. */}
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
  );
}

export function LanImportConnectFooter({
  controller,
  onClose,
}: {
  controller: LanImportConnectController;
  onClose: () => void;
}) {
  return (
    <>
      <span className="text-xs text-muted-foreground">
        {controller.isBusy
          ? controller.isAutoRetrying
            ? 'Retrying connection…'
            : 'Pairing with source device…'
          : 'Enter the address and code shown on the sharing device.'}
      </span>
      <div className="flex items-center gap-2">
        {controller.isBusy ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="lan-import-connect-cancel"
            onClick={controller.cancel}
          >
            Cancel
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="lan-import-connect-close"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="lan-import-connect-submit"
              onClick={() => void controller.submit()}
            >
              Connect
            </Button>
          </>
        )}
      </div>
    </>
  );
}
