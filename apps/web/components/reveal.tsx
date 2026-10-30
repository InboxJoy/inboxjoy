"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Adds .is-visible the first time the section scrolls into view, so the
 *  CSS in marketing.css can stagger its children in. */
export function Reveal({ children, className = "", id }: { children: ReactNode; className?: string; id?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [motionReady, setMotionReady] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setMotionReady(true);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIsVisible(true);
      return;
    }
    // A deep-link or fast jump can skip the intersection entirely — reveal
    // anything already at or above the fold so it can never stay hidden.
    if (node.getBoundingClientRect().top < window.innerHeight) {
      setIsVisible(true);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    let revealed = false;
    let observer: IntersectionObserver | null = null;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      setIsVisible(true);
      observer?.unobserve(node);
      window.removeEventListener("pageshow", checkPosition);
      window.removeEventListener("scroll", checkPosition);
      window.removeEventListener("resize", checkPosition);
    };
    const checkPosition = () => {
      if (node.getBoundingClientRect().top < window.innerHeight) reveal();
    };
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting || entry.boundingClientRect.top < window.innerHeight) {
          reveal();
        }
      }
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.1 });
    observer.observe(node);
    window.addEventListener("pageshow", checkPosition);
    window.addEventListener("scroll", checkPosition, { passive: true });
    window.addEventListener("resize", checkPosition, { passive: true });
    const restorationCheck = window.setTimeout(checkPosition, 1200);
    return () => {
      window.clearTimeout(restorationCheck);
      window.removeEventListener("pageshow", checkPosition);
      window.removeEventListener("scroll", checkPosition);
      window.removeEventListener("resize", checkPosition);
      observer?.disconnect();
    };
  }, []);

  const revealClass = motionReady ? `mkt-reveal${isVisible ? " is-visible" : ""} ` : "";
  return <section className={`${revealClass}${className}`} id={id} ref={ref}>{children}</section>;
}
