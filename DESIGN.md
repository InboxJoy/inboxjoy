# DESIGN.md — InboxJoy design system

The reference for anyone (human or agent) building UI in this repo. It records
what the product **already looks like**, so new work matches instead of drifting.
When you add UI, reuse the tokens, classes, and patterns below before inventing
new ones. If you must add a new pattern, add it here in the same pass.

There are two visual worlds. Do not mix their class prefixes.

- **Dashboard / app** (`apps/web/app/app/**`) — the signed-in product. Styles in
  `apps/web/app/app/dashboard.css`, `dashboard-polish.css`, and
  `dashboard-responsive.css` (phone/tablet fixes only, loaded last). Class
  prefixes: `.rail-*`, `.polish-*`, `.campaign-*`, `.stat-*`, `.settings-*`,
  `.leads-*`, `.inbox-*`.
- **Marketing site** (`apps/web/app/page.tsx`, `_pages/`, `pricing/`, etc.) —
  the public pages. Styles in `apps/web/app/pages.css`. Class prefixes: `.v2-*`,
  `.v4-*`, `.pages-*`, `.mkt-*`. Light theme only.

## Tokens (source of truth: `dashboard.css` on `.app-shell`)

| Token | Value | Use |
|---|---|---|
| `--ij-ink` | `#16141f` | Primary text, filled/selected controls |
| `--ij-body` | `#5f5b73` | Body text |
| `--ij-muted` | `#9a93b8` | Secondary text, helpers, footers |
| `--ij-violet` | `#7c6cf0` | Primary accent (active nav, meters, tints) |
| `--ij-violet-solid` | `#6d5ae6` | Solid button fill (white text passes AA at 4.9:1) |
| `--ij-violet-solid-hover` | `#5b4bd6` | Solid button hover |
| `--ij-sky` | `#4ea8f5` | Secondary accent, gradients |
| `--ij-line` | `rgba(22,20,31,.07)` | Hairline borders, dividers |
| `--ij-glass` | `rgba(255,255,255,.82)` | Frosted panel backgrounds |

Never hardcode these hexes inline — reference the variable. The violet→sky
gradient (`#7c6cf0`→`#4ea8f5`) is the brand's one gradient; use it sparingly
(hero accents, brand marks), never on buttons or as a section background.

## Type

- App UI: **Instrument Sans**. Mono label/eyebrow accents: **IBM Plex Mono**
  (uppercase, letter-spaced — the `.polish-mono-label` / eyebrow style).
- Marketing site: **Google Sans Flex** (Google Fonts, wght 400–800) everywhere —
  headings and body. Manrope stays only as the fallback stack.
- Marketing headings: large, tight, two-line stacked (`<h2>Foo<br />Bar</h2>`).
- Sizes: body 13–14px in the app; helpers 11.5–12.5px; never below 11px.

## Layout & shape

- **Radii:** cards/panels 16–20px; pills and pill-buttons `999px`; inputs ~10px.
- **Elevation:** flat. The dashboard uses no drop shadows — separate surfaces
  with `--ij-line` borders; floating panels (modals, menus, toasts) rely on their
  border plus the backdrop. `box-shadow` is reserved for focus/selection rings
  (`0 0 0 3px` violet tint). Frosted panels use `--ij-glass` + `backdrop-filter`.
- **Spacing:** 16px is the default gap/padding unit; 20–24px for card padding.
- **Backgrounds:** app is white with two blurred radial brand glows
  (`.app-shell::before/::after`). Do not add solid colored section backgrounds.

## Core components & patterns (reuse these)

- **Sidebar rail** — `.rail-*` in `dashboard-polish.css`, rendered by
  `apps/web/components/app-shell.tsx`. Above 900px: collapsible, a 60px icon
  rail ⇄ a wider labelled rail. Width is state-driven through the `--rail-w`
  custom property so the main content margin always reflows with it — never
  widen the rail on `:hover` alone (that overlaps content). `position: fixed`
  children (e.g. the campaign action bar) clear the rail via `--rail-w`.
  641–900px: the rail is forced to the 60px icon-only state regardless of the
  pin. At 640px and below the rail itself is hidden and replaced by
  `.rail-topbar` — a 56px sticky bar (height in `--rail-topbar-h`) with the
  logo, a Search button (opens the command palette), and a Menu button that
  toggles `.rail-drawer`, a slide-in nav drawer (`min(84vw, 320px)`, white/glass
  + `backdrop-filter`) reusing the exact same nav/badge/warm-up/workspace JSX as
  the desktop rail (`app-shell.tsx`'s `railBody`), not a duplicate. The drawer
  and its `.rail-drawer-backdrop` are rendered as `position: fixed` siblings at
  the shell root — outside `<main>`, never inside a page's own animated root —
  so a page-enter transform can never become their containing block; see the
  `position: fixed` + animated-ancestor trap in `docs/regression-guardrails.md`.
  Escape and backdrop-click close the drawer, focus moves in on open and back
  to the Menu button on close, body scroll is locked while open, and it closes
  automatically on navigation. Transitions are transform/opacity, ≤200ms, and
  disabled under `prefers-reduced-motion`.
- **Workspace menu** — `components/workspace-menu.tsx`, `.rail-workspace-*`
  in `dashboard-polish.css`. Two or more active memberships turn the existing
  rail workspace block into a 44px menu button; the avatar is its collapsed-rail
  target. One membership and failed membership requests retain the static block.
  The shared rail body provides the same control in the mobile drawer. The menu
  uses a fixed portal into `.app-shell` for desktop and collapsed rails. Inside
  the mobile drawer, it portals into the drawer dialog and uses absolute,
  drawer-relative positioning with its width and height bounded by the drawer.
  Both placements inherit app tokens and keep options in the trigger's
  accessibility scope. Its z-index sits above the drawer/backdrop
  and below the command palette. A glass surface, hairline border, 16px radius,
  violet hover/selection tint, and focus ring reuse existing menu treatments.
  Dropdown and menu row labels (connect-mailbox menu, lead-list menu, workspace
  menu, command palette) share one weight through `--ij-menu-weight` (500);
  set new menus with that token instead of a literal weight.
  Each row shows the workspace name and role, with a check on the current row.
  Use `aria-haspopup="menu"`, `menu` / `menuitemradio`, and `aria-checked`;
  opening focuses the current row, arrows/Home/End move focus, and Escape
  closes and returns focus to the trigger. Tab closes the menu and returns
  focus to its trigger inside the mobile drawer. Outside pointer clicks dismiss the
  menu and reach their target. Switching shows inline progress/error and loads
  `/app` through full navigation after the server confirms the selection.
- **Nav / control icons** — `lucide-react`, via `apps/web/components/nav-icon.tsx`
  for nav, or imported directly for one-off controls. Use lucide, not ad-hoc SVG.
  Sidebar collapse uses `PanelLeftClose` / `PanelLeftOpen`.
- **Row actions** — table rows with several actions (Mailboxes, Campaigns) use
  icon buttons: `.inbox-tool-buttons` wrapping `.inbox-tool-btn` (32px, 40px on
  phones), each with `aria-label` and `data-tooltip` set to the action name (no
  `title`: the browser tooltip doubled the styled one). Destructive actions add
  `.inbox-tool-btn--danger`. Mailboxes: the trash action is "Delete mailbox"
  (confirm first); it hides the mailbox everywhere and keeps its send history.
- **Pill tabs** — page-level tabs are a rounded strip of pills with an
  ink-filled selected state (`background: var(--ij-ink); color:#fff`). See
  `.campaign-detail-tabs` and `.leads-modal-tabs`. Keep them compact
  (~32px tall). Always accessible: `role="tablist"`/`tab`/`tabpanel`,
  `aria-selected`, roving `tabIndex`, arrow-key nav.
- **Cards** — `Card` from `@inboxjoy/ui`; white/glass, `--ij-line` border,
  16–20px radius. Stat cards use `StatCard` (big value + muted helper line);
  put secondary numbers in the helper, not as new top-level cards.
  Every stat card (Dashboard, Mailboxes, Analytics, Refer & earn, campaign
  summary) uses the same treatment: mono label, value, helper. No decorative
  bars, gradient rules or tone stripes; a bar appears only when it shows a
  real ratio (e.g. the Dashboard sparklines). Desktop rows stay even
  (Analytics 5 across, Refer & earn 3 + 3); phones show two per row and an
  odd last card spans the row.
- **Status** — `StatusBadge` from `@inboxjoy/ui` with tones
  `neutral | good | warning | danger | info`. Campaign badges use the single
  shared map in `packages/ui/src/index.tsx`: `campaignDisplayStatus(campaign)`,
  `campaignStatusLabel`, `campaignStatusTone`, and `campaignStatusReasonText`.
  Campaign display statuses: Draft (`draft`) → neutral, Active (`active`) → good,
  Needs attention (`needs_attention`) → danger, Paused (`paused`) → warning,
  Finished (`finished`) → info, Archived (`archived`) → neutral. Responses without
  `displayStatus` derive it from stored `status`: `completed` → `finished`,
  `published` → `active`, with the remaining states unchanged. Enrollment and
  lead badges keep replied/completed → good, bounced/cancelled → danger,
  paused → warning. A campaign's reason appears directly beneath its badge in
  the existing muted helper/small-text style, using `campaignStatusReasonText`.
  Finished campaigns can show their finish date in the same helper style.
  Campaign summary cards show waiting leads in a compact stacked notice with
  a primary “Send to new leads” button (“Resume and send to new leads” when
  paused); the notice stays within the card's 20px inset and its button wraps.
- **Campaigns list** — `sequences/page.tsx`. Seven columns that fit without
  side-scrolling from ~1280px: Campaign (name + one-line muted meta "3 steps ·
  description", full text in `title`), Progress, Open rate, Reply rate, Unsub
  rate, Status, Actions. Progress is "23 of 100 done" over a 5px
  `.enrollment-meter` with a helper "77 leads have emails left" (enrolled minus
  done; "All emails sent" once finished; "No leads yet" when empty). Rates show
  "—" before anyone is enrolled. Filter pills carry a muted count
  (`.polish-filter-count`) and hide statuses with no campaigns. On phones each
  row is a card: name, status, progress, the three rates, then actions.
- **Buttons** — `Button` from `@inboxjoy/ui` (`primary` solid `--ij-violet-solid` pill with `--ij-violet-solid-hover`,
  `secondary` outline, `ghost`). Destructive actions are subtle red text, gated
  by `window.confirm` (see `settings/danger/page.tsx`).
- **Invitation card** — `/app/invite/[token]` renders one centered `Card.invite-card`
  (max 460px): workspace initials tile, mono eyebrow, "Join {workspace}" title,
  inviter line, a hairline `dl.invite-details` (role badge, invited email, expiry),
  an amber/green `.invite-notice` for wrong-account / expired / already-member
  states, then centered pill actions that stack full-width under 480px.
- **Modal / dialog** — the reusable pattern is `.leads-modal-backdrop` +
  `<section role="dialog" aria-modal="true">` (`leads/add-leads-modal.tsx`).
  For simple destructive confirms, `window.confirm` is acceptable.
- **Tables** — CSS grid rows with a header row (`.polish-table-head`,
  `.table-head`, `.settings-table-head`, or `.campaign-table-head`) and
  horizontal scroll on desktop. The pattern covers every dashboard table:
  `.campaign-contact-row`, `.sequence-step-row`, `.campaign-table-row`
  (campaigns list), `.dashboard-campaign-row` (home dashboard),
  `.leads-table .table-row`, `.settings-table-row` (health/team/keys/oauth/
  affiliate variants — the affiliate referrals table at
  `app/app/(product)/affiliate/page.tsx` is a 3-column `--affiliate` variant:
  Date, Status, Earned), and `.inbox-account-grid` (mailboxes). At tablet (641–900px) the
  grid tracks tighten (see `dashboard-responsive.css`) instead of relying on
  side-scroll. On phones (≤640px) every one of these collapses each row into
  a labelled card rather than side-scrolling: the header row hides, each
  value cell carries a `data-label` attribute rendered as a small caps label
  via `::before` (`.campaign-contact-row` is the original example — replicate
  its `[data-label]::before` rule for any new table), and row actions keep a
  ≥40px tap target. This responsive behavior lives in
  `apps/web/app/app/dashboard-responsive.css`, loaded after `dashboard.css`
  and `dashboard-polish.css` so it can override their grid tracks by source
  order.

- **Team role select** — owner-managed member roles use a native Member / Admin
  select in the existing Role cell beside the row's Remove action. Reuse the
  global input/select border, radius, and focus treatment with
  `.settings-team-role-select` for compact sizing. The control's stacked helper
  shows saving, success, or error feedback with `role="status"` / `role="alert"`.
  Saving disables team actions; the refreshed list supplies the selected value.
  Owner rows and the viewer's own row retain their role badge. Phone layouts
  keep the existing labelled-card table pattern.

- **Reply inbox** — `.inbox-*` in `dashboard-polish.css`, used by
  `app/(product)/inbox/page.tsx`. A full-height list/thread split
  (`.inbox-replies-layout`, `minmax(320px, 400px) 1fr` above 900px, `~300px 1fr`
  down to 640px): the pane height is `calc(100dvh - var(--inbox-offset))`, where
  `--inbox-offset` is measured at runtime in the page component (viewport top to
  the grid, plus the main-content bottom gutter) rather than a hardcoded pixel
  value, so it tracks the plan banner and sidebar state. Each pane scrolls
  independently — the list pane (`.inbox-list-pane`) keeps its filter toolbar and
  pagination fixed with only `.inbox-list-scroll` scrolling; the thread pane
  (`.inbox-thread-pane`) is itself the scroll container, with a sticky header
  (`.inbox-thread-header`, `position: sticky; top: 0`) and a sticky composer
  (`.inbox-composer`, `position: sticky; bottom: 0` — never `position: fixed`, see
  the CSS traps in `docs/regression-guardrails.md`). Below 640px the grid becomes
  a single column (`data-mobile-view` on `.inbox-replies-layout` toggles which
  pane is visible) showing only the list until a reply is selected, then only the
  thread with a "Back to inbox" ghost button at top; heights go back to natural
  flow. List rows (`.inbox-row`) are flat with a hairline divider and a
  `rgba(22,20,31,.03)` hover tint; the selected row is a soft violet-tint card
  (`rgba(124,108,240,.09)` background + inset ring, not a solid fill) with a small
  inset margin and 12px radius — text stays ink/body colors. Unread state is a 6px
  violet dot (space always reserved) plus name weight, not a bespoke badge. Reply
  `intent` maps to `StatusBadge` tones consistently everywhere it appears (list
  row, thread header, thread entry): `auto_reply` → neutral "Auto-reply",
  `opt_out` → danger "Unsubscribed", `soft_decline` → warning "Not interested";
  `human` shows no chip. Thread messages are a card timeline; outbound ("Sent")
  entries collapse to a one-line summary button by default (the last entry is
  always expanded), and an inbound entry with `quotedText` gets a
  "Show/Hide quoted text" ghost toggle that reveals the trimmed quoted history
  with a 1px left border (the one place a colored left border is allowed, per the
  1px exception).

- **Marketing feature cards** — `.v2-showcase-*` in `marketing.css`, under the
  homepage hero. Full-width white row cards (`--ij-line` border, 20px radius,
  no shadow), one per feature: copy side (blue uppercase label, 34px/600
  heading, `.v2-showcase-list` checklist) and a `.v2-showcase-media` well —
  a violet-tint gradient panel spanning the card's full height with the
  product video inset 26px (border, 14px radius, soft shadow, cover-cropped
  anchored left). `--flip` swaps sides. One column below 900px, copy first;
  the well becomes a 16:10 block.
- **Marketing container width** — every section box below the hero aligns to
  the sticky navbar pill: outer max-width `1212px` with 26px side padding
  (content line 1160px). Exception: the FAQ stays at 880px for reading measure. Don't reintroduce other narrower per-section max-widths.

- **Marketing GitHub link** — the open-source signal on the public site. Styles
  are in `marketing.css`; the mark and the nav link live in
  `components/github-mark.tsx`, which every placement shares. All of them link to
  `SELF_HOST_REPO_URL` (`lib/site-links.ts`) with `target="_blank"` and
  `rel="noopener noreferrer"`. Use the official GitHub mark there (inline SVG,
  `currentColor`), not a lucide icon. Never show a star count or any other stat.
  - *Nav icon* (`GithubNavLink`, `.v2-nav-github`): a 36px round icon-only link,
    white at 80% opacity, a `rgba(255,255,255,.12)` fill and full white on hover,
    the usual white focus ring. `aria-label="InboxJoy on GitHub"`, `title="Open
    source on GitHub"`. It sits just left of the CTA in the hero nav
    (`.v2-nav-end`) and after "Log in" in the sticky bar, where it stays down to
    360px (34px under 560px). The hero nav is already full on phones, so under
    900px it moves into the mobile menu as a labelled row ("Open source on
    GitHub", `variant="menu"`, no `aria-label`) above "Log in".
  - *Hero pill* (`HeroGithubPill`, `.v2-hero-github`): above the h1, in the
    `.v2-hero-badges` row beside the dashed agents eyebrow. A 999px pill with a
    1px `rgba(255,255,255,.22)` border and a `rgba(255,255,255,.1)` fill, 13px/600
    white text, the GitHub mark, and an `ArrowUpRight` for the new tab. Text:
    "Open source · Self-host free on GitHub"; under 520px the "Self-host free"
    part drops so it reads "Open source on GitHub" and fits at 360px. The two
    pills sit side by side on desktop and stack, centered, on phones.

- **Plan prompt** — the single payment prompt is `PlanBanner` + the plan picker
  in `components/plan-picker.tsx` (`.plan-banner*`, `.plan-picker*` in
  `dashboard-polish.css`). The banner is a sticky frosted bar at the top of
  `.main-content` (one button). It only shows for free-plan workspaces: "N of
  10,000 free sends used this month" from 80% of the limit, "You've used this
  month's 10,000 free sends" once it's reached, or "Start your Monthly plan"
  when the signup carried a plan hint. Page-level banners such as email
  verification stack below it in normal flow. The picker is an `AppDialog`
  ("Upgrade InboxJoy") with two radio cards rendered from `lib/plans.ts` (the
  same data as the paid marketing pricing cards; the Free card lives only in
  `_pages/plan-cards.tsx`). Anything that needs to offer plans calls
  `usePlanPicker().openPlans()` — don't add another upgrade prompt.
- **Free-plan usage** (Settings → Billing, `.billing-usage` in
  `dashboard-polish.css`) — a line "3,214 of 10,000 sends used this month" with
  a muted "Resets Nov 1" on the right, then the 5px `.enrollment-meter` bar,
  then one muted 12px helper line about the "Sent via InboxJoy" footer. It sits
  inside the subscription card above `.settings-actions`.
- **Setting toggle** (`.settings-toggle`, shares `.inbox-warmup-toggle` rules) —
  a bordered row with a checkbox, a bold one-line label and a muted helper that
  states the trade-off. The card heading carries an On/Off `StatusBadge` and a
  sentence describing the current state. Saving happens on change, with the
  usual toast. First use: Settings → Sending → Open tracking.
- **Open tracking off** (`OpenTrackingOff` in `components/open-tracking.tsx`) —
  while a workspace's open tracking is off, every open count or rate (campaign
  list, campaign step table, Analytics card) shows a muted dotted-underline
  "Off" linking to the setting instead of a number, and the opens chart shows
  an empty state with the same link. Read the setting with
  `useOpenTrackingEnabled()`; while it loads, numbers render as before.

- **Server-checked review value** — use when a review step needs a value from
  the server before its primary action can proceed, as with the audience
  eligible-count check in the campaign wizard's review step
  (`campaign-wizard.tsx`). The value is one `<dt>`/`<dd>` row inside a `<dl>`
  (`.campaign-review-card`), with three states: checking (`<dd>` reads
  "Checking…"), ready (`<dd>` shows the resolved value; the row gets
  `.is-attention` if the value needs the user's attention), and could not
  check (`<dd>` wraps the failure text and a "Retry" button together in
  `<span role="alert">`, the button styled `ij-button ij-button--ghost` and
  re-running the check on click). The primary action button
  (`ij-button ij-button--primary`) stays `disabled` until the check resolves
  favorably, with the current reason ("Checking eligible contacts…", "Could
  not check eligible contacts — try again", or the specific blocker) in its
  `title` attribute rather than new on-page copy.

- **Lead variables** — per-lead, per-campaign custom `{{name}}` values. Styles
  `.lead-var-*` at the end of `dashboard-polish.css` (phone rules in
  `dashboard-responsive.css`); logic in `apps/web/lib/lead-variables.ts`.
  - *Token chip* (`.lead-var-chip`): mono 11.5px pill showing `{{name}}`. Built-ins
    use the neutral chip; custom variables add `.lead-var-chip--custom` (violet
    tint, `--ij-violet-solid` text). Used for the "Variables in this email" list
    under each step, the CSV mapping target, and the Variables card.
  - *Insert variable picker* (`variable-tools.tsx`): a native `select` under the
    step body (Standard / Custom groups plus "New variable…", which reveals an
    inline name input validated against `^[A-Za-z][A-Za-z0-9_]{0,63}$`). It
    inserts at the caret of the last-focused subject or body field. The editor
    stays a plain textarea; no rich-text overlay.
  - *Variables card* (`sequences/[id]/variables-card.tsx`): one row per custom
    variable: chip button, "142 / 150 leads ready", a `StatusBadge` (`good`
    "Ready" or `warning` "N missing"), and a 5px `.lead-var-meter` bar (same
    track/fill as `.enrollment-meter`). Hidden when the steps use only built-ins.
  - *Lead variables dialog* (`sequences/lead-variables-dialog.tsx`): the
    `.leads-modal-backdrop` dialog pattern, portaled into `.app-shell`, with
    All / Missing pill tabs, search, an optional variable select, and the
    standard contacts pagination footer. Cells show the value (truncated, full
    text in `title`) plus a mono source tag ("This campaign" / "Lead field");
    missing cells use a dashed border and a `warning` "Missing" badge. Clicking a
    cell swaps it for a textarea with Save / Cancel (Cmd/Ctrl+Enter saves, Escape
    cancels); an empty value removes it. Edits apply at once and roll back with
    an error if the save fails.
  - *Table exception:* because its columns are dynamic, this table keeps its
    columns on phones and scrolls inside `.lead-var-table-wrap` (the first column
    is sticky) instead of collapsing into labelled cards. The page never scrolls
    sideways.
  - *Preview as lead* (`preview-as-lead.tsx`): a "Preview as" select plus search
    above the wizard's email preview. Missing values appear as `[name]`
    highlighted with `.lead-var-missing` (amber tint).
- **Export & import** (`settings/export/page.tsx`, `.settings-transfer-meta` at
  the end of `dashboard-polish.css`) — owner-only settings page with two
  `settings-card`s. The label/value list is a `dl.settings-transfer-meta`
  (muted 12.5px `dt`, body-color `dd`, `max-content 1fr` grid, same treatment
  as `.oauth-consent-meta`), used for "Included / Not included", the chosen
  file's summary and the import result. A native file input sits in a
  `.settings-form` label; the import button stays disabled until the file
  passes the browser check, and a `window.confirm` names the counts and the
  target workspace. Result lists (invitation links with "Copy link",
  mailboxes to reconnect, campaign audiences to pick again) reuse
  `.settings-table-row--team` rows with `data-label` cells; the invitation
  table carries `ph-no-capture`.
- **OAuth consent card** (`app/mcp/authorize`, `.oauth-consent-card`) — a single
  `settings-card` outside the dashboard shell: mono eyebrow "Connected app",
  "Authorize {client}" heading, then a hairline-free `dl.oauth-consent-meta`
  (muted label / body value: "Will send access to" → redirect host in 600 weight,
  "Registered" → date). Every client self-registers, so the head badge is always
  `StatusBadge` `warning` "Unverified app". Scopes, workspace select and the
  Approve / Deny pair follow unchanged.

## Responsive

- Breakpoints in the app: 900px (rail forced to the 60px icon state) and 640px
  (rail hides in favor of a sticky top bar + slide-in drawer; tables become
  stacked cards). Everything must work at ~390px with a ≥16px side gutter and
  no horizontal body scroll.
- Tablet (641–900px) is not just "desktop but narrower": table grid tracks get
  a tighter set of `minmax()` values at this breakpoint (see
  `dashboard-responsive.css`) so simple tables (settings, leads, mailboxes)
  need little or no contained horizontal scroll, while a wide table (the full
  campaigns list) may still scroll within its own card — never the page body.

## Voice

Stark, short, non-salesy. Concrete specifics over adjectives. **No exclamation
marks** in product copy. **US English** sitewide. State what exists today; hedge
competitor claims honestly. Labels are Sentence case, not Title Case.
`labelStatus()` in `@inboxjoy/ui` turns raw codes into Sentence case
("auth_error" → "Auth error"); timestamps use `formatDateTime()` ("Oct 19,
4:02 PM", no seconds). Never show raw `toLocaleString()` output or vendor
names (Azure, Composio) in product copy. Form controls inherit the app font;
the CSV paste box is the one intentional monospace field.

## Verifying UI changes

The hidden browser pane does not paint reliably — verify visual changes with a
real rendered screenshot (real Chrome against dev or localhost), at desktop and
phone widths when layout changed. "It's in the bundle" is not verification.
See `docs/regression-guardrails.md`.
