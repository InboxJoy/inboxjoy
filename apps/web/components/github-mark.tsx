import { SELF_HOST_REPO_URL } from "@/lib/site-links";

export const GITHUB_LINK_LABEL = "InboxJoy on GitHub";
export const GITHUB_LINK_TOOLTIP = "Open source on GitHub";

/**
 * The GitHub mark (octicon "mark-github", 16px grid), drawn in currentColor so
 * it follows the text colour of whatever it sits in. Decorative: the link or
 * button around it carries the accessible name.
 */
export function GithubMark({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" focusable="false" height={size} viewBox="0 0 16 16" width={size}>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/**
 * Link from the marketing nav to the open-source repository. `icon` is the
 * round icon-only button used in the desktop and sticky bars; `menu` is the
 * labelled row inside the mobile menu panel. Opens in a new tab.
 */
export function GithubNavLink({ className, tabIndex, variant = "icon" }: { className?: string; tabIndex?: number; variant?: "icon" | "menu" }) {
  const classes = ["v2-nav-github", variant === "menu" ? "v2-nav-github--menu" : "", className ?? ""].filter(Boolean).join(" ");
  if (variant === "menu") {
    return (
      <a className={classes} href={SELF_HOST_REPO_URL} rel="noopener noreferrer" tabIndex={tabIndex} target="_blank">
        <GithubMark size={18} />
        {GITHUB_LINK_TOOLTIP}
      </a>
    );
  }
  return (
    <a aria-label={GITHUB_LINK_LABEL} className={classes} href={SELF_HOST_REPO_URL} rel="noopener noreferrer" tabIndex={tabIndex} target="_blank" title={GITHUB_LINK_TOOLTIP}>
      <GithubMark size={18} />
    </a>
  );
}
