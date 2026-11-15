import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

let loader: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loader = null;
        reject(new Error("turnstile failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return loader;
}

interface Props {
  siteKey: string;
  onToken: (token: string | null) => void;
  onError?: () => void;
  resetSignal: number;
}

export function Turnstile({ siteKey, onToken, onError, resetSignal }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef({ onToken, onError });
  cb.current = { onToken, onError };

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !el.current || !window.turnstile) return;
        widget.current = window.turnstile.render(el.current, {
          sitekey: siteKey,
          action: "submit",
          theme: "light",
          size: "flexible",
          "refresh-expired": "auto",
          callback: (t: string) => cb.current.onToken(t),
          "expired-callback": () => cb.current.onToken(null),
          "error-callback": () => {
            cb.current.onToken(null);
            cb.current.onError?.();
          },
        });
      })
      .catch(() => cb.current.onError?.());
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetSignal > 0 && widget.current && window.turnstile) {
      cb.current.onToken(null);
      window.turnstile.reset(widget.current);
    }
  }, [resetSignal]);

  return <div ref={el} className="min-h-[65px]" />;
}
