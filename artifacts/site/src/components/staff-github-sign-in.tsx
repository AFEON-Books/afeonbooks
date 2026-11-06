import { useRef, useState } from "react";
import { Github } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { TurnstileWidget } from "@/components/turnstile-widget";

export function StaffGithubSignIn({ returnUrl }: { returnUrl: string }) {
  const [turnstileOpen, setTurnstileOpen] = useState(false);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  const handleTurnstileToken = (token: string) => {
    if (!token) return;
    const form = formRef.current;
    const tokenInput = tokenInputRef.current;
    const targetName = `afeonbooks-github-${crypto.randomUUID()}`;
    const githubWindow = window.open("about:blank", targetName);
    if (!githubWindow) {
      setError("Your browser blocked the GitHub tab. Allow pop-ups and try the security check again.");
      setTurnstileResetKey((current) => current + 1);
      return;
    }
    if (!form || !tokenInput) {
      githubWindow.close();
      setError("Unable to start GitHub sign-in. Please try again.");
      return;
    }

    tokenInput.value = token;
    form.target = targetName;
    form.submit();
    setTurnstileOpen(false);
    setError("");
  };

  return (
    <>
      <main className="flex min-h-screen items-center justify-center bg-[#FAF7F2] px-6 text-center">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-semibold">Sign in with GitHub</h1>
          <p className="mt-2 text-sm text-black/60">Use a GitHub account that belongs to the AFEON Books organization.</p>
          <button
            type="button"
            onClick={() => { setError(""); setTurnstileOpen(true); }}
            className="mt-6 inline-flex items-center gap-3 rounded-md bg-[#24292f] px-5 py-3 font-semibold text-white hover:bg-[#32383f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24292f]"
          >
            <Github aria-hidden="true" size={20} />
            Sign in with GitHub
          </button>
          {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
        </div>
      </main>
      <Dialog open={turnstileOpen} onOpenChange={setTurnstileOpen}>
        <DialogContent className="w-[min(94vw,360px)] gap-2 p-5">
          <DialogTitle className="sr-only">Turnstile security check</DialogTitle>
          <DialogDescription className="sr-only">Complete the security check to continue to GitHub.</DialogDescription>
          {turnstileOpen && (
            <>
              <TurnstileWidget
                action="staff_github_login"
                onToken={handleTurnstileToken}
                onError={setError}
                resetKey={turnstileResetKey}
              />
              {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
              <form ref={formRef} method="post" action="https://api.afeonbooks.com/api/auth/github/start">
                <input ref={tokenInputRef} type="hidden" name="cf-turnstile-response" />
                <input type="hidden" name="return_to" value={returnUrl} />
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
