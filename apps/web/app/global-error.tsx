"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) posthog.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="auth-page">
          <section className="auth-card auth-status-card">
            <p className="landing-kicker">Application error</p>
            <h1>Something went wrong.</h1>
            <p role="alert">We could not load this page. Try again.</p>
            <button className="ij-button ij-button--primary auth-status-action" onClick={reset} type="button">Try again</button>
          </section>
        </main>
      </body>
    </html>
  );
}
