"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL } from "@/lib/site-links";

// New offer, new key: visitors who dismissed the old lifetime-license banner see this one.
export const ANNOUNCEMENT_DISMISSED_UNTIL_KEY =
  "inboxjoy:open-source-managed-announcement-dismissed-until";

const DISMISSAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const ANNOUNCEMENT_HEIGHT_PROPERTY = "--mkt-announcement-height";
export const ANNOUNCEMENT_HEIGHT_EVENT = "inboxjoy:announcement-height";

export type AnnouncementBannerProps = {
  className?: string;
  onHeightChange?: (height: number) => void;
};

function dismissalIsActive(): boolean {
  try {
    const dismissedUntil = Number(
      window.localStorage.getItem(ANNOUNCEMENT_DISMISSED_UNTIL_KEY),
    );
    return Number.isFinite(dismissedUntil) && dismissedUntil > Date.now();
  } catch {
    return false;
  }
}

export function AnnouncementBanner({
  className = "",
  onHeightChange,
}: AnnouncementBannerProps) {
  const bannerRef = useRef<HTMLElement>(null);
  const [isVisible, setIsVisible] = useState(true);

  const reportHeight = useCallback(
    (height: number) => {
      document.documentElement.style.setProperty(
        ANNOUNCEMENT_HEIGHT_PROPERTY,
        `${height}px`,
      );
      window.dispatchEvent(new CustomEvent(ANNOUNCEMENT_HEIGHT_EVENT));
      onHeightChange?.(height);
    },
    [onHeightChange],
  );

  useEffect(() => {
    if (dismissalIsActive()) setIsVisible(false);
  }, []);

  useEffect(() => {
    const banner = bannerRef.current;
    if (!isVisible || !banner) {
      reportHeight(0);
      return;
    }

    const updateHeight = () => reportHeight(banner.getBoundingClientRect().height);
    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight, { passive: true });
      return () => {
        window.removeEventListener("resize", updateHeight);
        reportHeight(0);
      };
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(banner);
    return () => {
      observer.disconnect();
      reportHeight(0);
    };
  }, [isVisible, reportHeight]);

  const dismiss = () => {
    try {
      window.localStorage.setItem(
        ANNOUNCEMENT_DISMISSED_UNTIL_KEY,
        String(Date.now() + DISMISSAL_DURATION_MS),
      );
    } catch {
      // Storage can be unavailable in private browsing. Dismiss for this view.
    }
    setIsVisible(false);
  };

  if (!isVisible) return null;

  return (
    <aside
      className={`mkt-announcement${className ? ` ${className}` : ""}`}
      data-announcement-banner=""
      data-state="visible"
      ref={bannerRef}
      role="region"
      aria-label="Self-host or managed"
    >
      <div className="mkt-announcement__inner">
        <p className="mkt-announcement__copy">
          <span className="mkt-announcement__copy-desktop">
            Self-host InboxJoy free, or let us run it: $79 once, lifetime.
          </span>
          <span className="mkt-announcement__copy-mobile">
            Open source, or managed
          </span>
        </p>
        <Link className="mkt-announcement__link" href={PRIMARY_CTA_HREF}>
          {PRIMARY_CTA_LABEL}
        </Link>
      </div>
      <button
        className="mkt-announcement__dismiss"
        type="button"
        onClick={dismiss}
        aria-label="Dismiss announcement for seven days"
      >
        <X aria-hidden="true" size={16} strokeWidth={2} />
      </button>
    </aside>
  );
}
