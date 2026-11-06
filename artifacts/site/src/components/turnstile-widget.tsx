import { useEffect, useRef } from "react";

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    sitekey: string;
    action: string;
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  }) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const sitekey = "0x4AAAAAAFY8DMwA2P5bWehZ";
let turnstilePromise: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstilePromise) return turnstilePromise;

  turnstilePromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => {
      const turnstile = window.turnstile;
      if (turnstile) resolve(turnstile);
      else {
        turnstilePromise = undefined;
        reject(new Error("Turnstile unavailable"));
      }
    };
    script.onerror = () => {
      turnstilePromise = undefined;
      reject(new Error("Unable to load Turnstile"));
    };
    document.head.append(script);
  });
  return turnstilePromise;
}

export function TurnstileWidget({
  action,
  onToken,
  onError,
  resetKey,
}: {
  action: string;
  onToken: (token: string) => void;
  onError?: (message: string) => void;
  resetKey: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  onTokenRef.current = onToken;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then((turnstile) => {
      if (cancelled || !container.current) return;
      widgetId.current = turnstile.render(container.current, {
        sitekey,
        action,
        callback: (token) => onTokenRef.current(token),
        "expired-callback": () => onTokenRef.current(""),
        "error-callback": () => {
          onTokenRef.current("");
          onErrorRef.current?.("The security check could not load. Close this check and try again.");
        },
      });
    }).catch(() => {
      onTokenRef.current("");
      onErrorRef.current?.("The security check could not load. Close this check and try again.");
    });

    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = undefined;
      onTokenRef.current("");
    };
  }, [action]);

  useEffect(() => {
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }, [resetKey]);

  return <div ref={container} className="min-h-[65px]" />;
}