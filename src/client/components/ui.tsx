import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";

export function Banner({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "ok" | "warn" | "bad";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "warn" ? AlertTriangle : tone === "bad" ? XCircle : Info;
  return (
    <div
      role={tone === "bad" || tone === "warn" ? "alert" : "status"}
      className={clsx(
        "flex gap-3 rounded-xl px-4 py-3 text-[15px]",
        tone === "info" && "bg-paper-2 text-ink",
        tone === "ok" && "bg-ok-soft text-ok",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "bad" && "bg-bad-soft text-bad",
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-[18px] shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={clsx(title && "mt-0.5", "text-ink-2")}>{children}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={clsx("size-4 animate-spin", className)} />;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  tone = "primary",
  busy,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  tone?: "primary" | "danger" | "fire";
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40 data-[state=open]:animate-[fade_150ms_ease-out]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card p-6 shadow-[var(--shadow-lift)] focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {description ? <Dialog.Description className="mt-2 text-[15px] text-ink-2">{description}</Dialog.Description> : null}
          {children}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close asChild>
              <button type="button" className="btn-outline" disabled={busy}>
                {cancelLabel}
              </button>
            </Dialog.Close>
            <button
              type="button"
              className={tone === "danger" ? "btn-danger" : tone === "fire" ? "btn-fire" : "btn-primary"}
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? <Spinner /> : null}
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  width = "max-w-xl",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className={clsx("fixed inset-y-0 right-0 z-40 flex w-full flex-col bg-card shadow-[var(--shadow-lift)] focus:outline-none", width)}
        >
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="btn-ghost btn-sm" aria-label="Close panel">
                Close
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
