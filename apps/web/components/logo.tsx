import Link from "next/link";

import styles from "./logo.module.css";

type LogoProps = {
  variant?: "dark" | "white";
  size?: "sm" | "md" | "lg";
  href?: string;
  className?: string;
  tabIndex?: number;
};

export function Logo({
  variant = "dark",
  size = "md",
  href,
  className,
  tabIndex,
}: LogoProps) {
  const classes = [styles.logo, styles[variant], styles[size], className].filter(Boolean).join(" ");
  const content = (
    <>
      <img src="/brand/icon-64x64.png" alt="" width={size === "sm" ? 22 : size === "lg" ? 34 : 28} height={size === "sm" ? 22 : size === "lg" ? 34 : 28} />
      <span className={styles.wordmark}>InboxJoy</span>
    </>
  );

  if (href) {
    return <Link className={classes} href={href} tabIndex={tabIndex}>{content}</Link>;
  }

  return <span className={classes}>{content}</span>;
}
