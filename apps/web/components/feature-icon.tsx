export type FeatureIconName =
  | "draft" | "window" | "limits" | "mailbox" | "reply" | "import"
  | "tags" | "ramp" | "chart" | "list" | "plug" | "key" | "team" | "shield" | "spark";

/** Modern duotone line icons: a soft filled shape under a crisp stroke. */
const icons: Record<FeatureIconName, { fill: string; stroke: string }> = {
  draft: {
    fill: "M5 15.5 15.2 5.3a2.5 2.5 0 0 1 3.5 3.5L8.5 19H5v-3.5Z",
    stroke: "M5 19h3.5L18.7 8.8a2.5 2.5 0 0 0-3.5-3.5L5 15.5V19ZM14 7l3 3M4 22h16",
  },
  window: {
    fill: "M12 3a9 9 0 0 1 9 9h-9V3Z",
    stroke: "M12 7.5V12l3.2 2M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z",
  },
  limits: {
    fill: "M12 20a8 8 0 0 1 0-16v8l5.6-5.6A8 8 0 0 1 12 20Z",
    stroke: "M4 18a9 9 0 1 1 16 0M12 13l4.2-4.2",
  },
  mailbox: {
    fill: "M3.5 7.5 12 13l8.5-5.5V9L12 14.6 3.5 9V7.5Z",
    stroke: "M3.5 7a1.5 1.5 0 0 1 1.5-1.5h14A1.5 1.5 0 0 1 20.5 7v10a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17V7Zm0 .6L12 13.4l8.5-5.8",
  },
  reply: {
    fill: "M9.5 9.2 5 13.4l4.5 4.2v-8.4Z",
    stroke: "M9.5 9.2 5 13.4l4.5 4.2M5 13.4h8.6a5.5 5.5 0 0 0 5.5-5.5V5",
  },
  import: {
    fill: "M12 4v9.4l3.6-3.6 1.1 1.1L12 15.6 7.3 10.9l1.1-1.1L12 13.4V4Z",
    stroke: "M12 4v10m0 0 4-4m-4 4-4-4M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5",
  },
  tags: {
    fill: "M4 5.5A1.5 1.5 0 0 1 5.5 4h5.4a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-5.3 5.3a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 4 11V5.5Z",
    stroke: "M4 5.5A1.5 1.5 0 0 1 5.5 4h5.4a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-5.3 5.3a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 4 11V5.5ZM8.5 8.5h.01",
  },
  ramp: {
    fill: "M4 19c5.5 0 11-3.5 13.5-10.5l.5 4 2-6-6.2 1 3.4 1.4C15 15 10 17.5 4 17.5V19Z",
    stroke: "M4 18c6 0 12-3 14.5-11M14 6.5 20 5l-1.2 6M4 21h16",
  },
  chart: {
    fill: "M6 13h2.6v6H6v-6Zm4.7-5h2.6v11h-2.6V8Zm4.7-4H18v15h-2.6V4Z",
    stroke: "M6.5 20v-6.5m5-4.5v11m5-15v15M3.5 20h17",
  },
  list: {
    fill: "M4 5.5h3v3H4v-3Zm0 5h3v3H4v-3Zm0 5h3v3H4v-3Z",
    stroke: "M10 7h10M10 12h10M10 17h10M4.5 6h2v2h-2V6Zm0 5h2v2h-2v-2Zm0 5h2v2h-2v-2Z",
  },
  plug: {
    fill: "M9 3v5h6V3h2v5a5 5 0 0 1-4 4.9V21h-2v-8.1A5 5 0 0 1 7 8V3h2Z",
    stroke: "M8 3v5m8-5v5M7 8h10a5 5 0 0 1-5 5 5 5 0 0 1-5-5Zm5 5v8",
  },
  key: {
    fill: "M14.5 3a6.5 6.5 0 0 0-6.2 8.4L3 16.7V21h4.3l1.2-1.2v-2.1h2.1l1.5-1.5a6.5 6.5 0 1 0 2.4-13.2Z",
    stroke: "M8.3 11.4A6.5 6.5 0 1 1 12.6 15.7L11 17.3H9v2l-1.5 1.5H4v-3.3l4.3-4.3ZM16 8h.01",
  },
  team: {
    fill: "M9 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 8a6 6 0 0 1 12 0H3Z",
    stroke: "M9 11.5A3.5 3.5 0 1 0 9 4.5a3.5 3.5 0 0 0 0 7ZM3.5 20a5.5 5.5 0 0 1 11 0M15.5 5a3.5 3.5 0 0 1 0 6.7M17 14.6A5.5 5.5 0 0 1 20.5 20",
  },
  shield: {
    fill: "M12 3 5 6v5c0 4.6 3 8.4 7 10 4-1.6 7-5.4 7-10V6l-7-3Z",
    stroke: "M12 3 5 6v5c0 4.6 3 8.4 7 10 4-1.6 7-5.4 7-10V6l-7-3ZM9.3 12l2 2 3.4-4",
  },
  spark: {
    fill: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3Z",
    stroke: "M12 3.5 13.7 8.6 19 10.3l-5.3 1.7L12 17.2l-1.7-5.2L5 10.3l5.3-1.7L12 3.5ZM18.5 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z",
  },
};

export function FeatureIcon({ name }: { name: FeatureIconName }) {
  const icon = icons[name];
  return (
    <svg aria-hidden="true" className="v2-feature-icon" viewBox="0 0 24 24" fill="none">
      <path d={icon.fill} fill="currentColor" opacity="0.16" />
      <path d={icon.stroke} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
