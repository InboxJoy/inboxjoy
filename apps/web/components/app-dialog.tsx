"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function AppDialog({
  actions,
  children,
  dismissible = true,
  eyebrow,
  onClose,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  dismissible?: boolean;
  eyebrow?: string;
  onClose: () => void;
  title: string;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
    (firstFocusable ?? dialogRef.current)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)];
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [dismissible]);

  return <div className="leads-modal-backdrop" onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) onClose(); }}>
    <section aria-labelledby={titleId} aria-modal="true" className="product-modal" ref={dialogRef} role="dialog" tabIndex={-1}>
      <header className="product-modal__header">
        <div>{eyebrow ? <p className="ij-eyebrow">{eyebrow}</p> : null}<h2 id={titleId}>{title}</h2></div>
        {dismissible ? <button aria-label="Close dialog" onClick={onClose} type="button">✕</button> : null}
      </header>
      <div className="product-modal__body">{children}</div>
      {actions ? <footer className="product-modal__actions">{actions}</footer> : null}
    </section>
  </div>;
}
