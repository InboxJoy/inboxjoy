"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// Checkout sessions created before the in-app plan picker still cancel back to
// /pricing?checkout=cancelled; new ones return to /app?checkout=cancelled.
export function CheckoutCancelledNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(new URLSearchParams(window.location.search).get("checkout") === "cancelled");
  }, []);

  const dismiss = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("checkout");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    setVisible(false);
  };

  if (!visible) return null;

  return <div className="pricing-cancelled-notice" role="status">
    <p>Checkout closed. Your workspace is ready, and you can get the lifetime license from inside InboxJoy whenever you like.</p>
    <div>
      <Link href="/app">Open InboxJoy</Link>
      <button aria-label="Dismiss checkout notice" onClick={dismiss} type="button">✕</button>
    </div>
  </div>;
}
