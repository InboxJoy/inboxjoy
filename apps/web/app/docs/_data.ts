export type DocPage = {
  href: string;
  label: string;
  title: string;
  description: string;
};

export type DocGroup = {
  title: string;
  pages: readonly DocPage[];
};

export const DOC_OVERVIEW: DocPage = {
  href: "/docs",
  label: "Overview",
  title: "Overview",
  description: "Choose a guide and complete your next task in InboxJoy.",
};

export const DOC_GROUPS: readonly DocGroup[] = [
  {
    title: "Getting started",
    pages: [
      {
        href: "/docs/quickstart",
        label: "Launch your first campaign",
        title: "Launch your first campaign",
        description: "Connect a mailbox, import leads, draft and test a campaign, then enroll your audience with delivery safeguards on.",
      },
      {
        href: "/docs/connect-inbox",
        label: "Connect a mailbox",
        title: "Connect your Gmail or Outlook account",
        description: "Connect Gmail or Outlook in one click without DNS records or a dedicated sending domain, then set mailbox limits.",
      },
      {
        href: "/docs/import-leads",
        label: "Import leads",
        title: "Import leads",
        description: "Upload a CSV or import through MCP. Duplicates and suppressed addresses are skipped automatically.",
      },
    ],
  },
  {
    title: "Sending",
    pages: [
      {
        href: "/docs/campaigns",
        label: "Create a campaign",
        title: "Create and manage a campaign",
        description: "Draft a campaign with AI, refine its steps, publish it, enroll leads, and review analytics.",
      },
      {
        href: "/docs/warmup-and-limits",
        label: "Manage warm-up and limits",
        title: "Manage warm-up and sending limits",
        description: "Understand the warm-up ramp, set mailbox caps and windows, and respond to bounce-related limits.",
      },
      {
        href: "/docs/troubleshooting",
        label: "Fix common errors",
        title: "Fix sending and setup errors",
        description: "Resolve test-send failures, pending mailbox addresses, paused ramps, and invite-gated signup.",
      },
    ],
  },
  {
    title: "Agents & API",
    pages: [
      {
        href: "/docs/mcp",
        label: "Connect an AI agent",
        title: "Connect Claude, ChatGPT, or Cursor",
        description: "Connect InboxJoy as a remote MCP server, approve scopes, use tools, and revoke access.",
      },
      {
        href: "/docs/api",
        label: "Use the REST API",
        title: "Use the REST API",
        description: "Create an API key, authenticate requests, use common endpoints, and handle rate limits.",
      },
    ],
  },
];

export const DOC_PAGES: readonly DocPage[] = [
  DOC_OVERVIEW,
  ...DOC_GROUPS.flatMap((group) => group.pages),
];
