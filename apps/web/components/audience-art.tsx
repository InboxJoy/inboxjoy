type Variant = "founder" | "team" | "agency";

const palettes: Record<Variant, [string, string, string]> = {
  founder: ["#7c6cf0", "#4ea8f5", "#e879b9"],
  team: ["#4ea8f5", "#6cc8f7", "#7c6cf0"],
  agency: ["#e879b9", "#7c6cf0", "#6cc8f7"],
};

/** Generative mesh artwork — unique per card, no stock imagery. */
export function AudienceArt({ variant }: { variant: Variant }) {
  const [a, b, c] = palettes[variant];
  const seed = variant === "founder" ? 0 : variant === "team" ? 1 : 2;

  return (
    <svg className="v2-audience-art" viewBox="0 0 320 200" role="img" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id={`g1-${variant}`} cx="30%" cy="35%">
          <stop offset="0%" stopColor={a} stopOpacity="0.95" />
          <stop offset="100%" stopColor={a} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`g2-${variant}`} cx="72%" cy="60%">
          <stop offset="0%" stopColor={b} stopOpacity="0.9" />
          <stop offset="100%" stopColor={b} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`g3-${variant}`} cx="55%" cy="18%">
          <stop offset="0%" stopColor={c} stopOpacity="0.75" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="320" height="200" fill="#0f1235" />
      <ellipse cx={96 + seed * 26} cy={72} rx="140" ry="118" fill={`url(#g1-${variant})`} />
      <ellipse cx={232 - seed * 20} cy={128} rx="132" ry="110" fill={`url(#g2-${variant})`} />
      <ellipse cx={176 + seed * 14} cy={34} rx="118" ry="86" fill={`url(#g3-${variant})`} />
      <g opacity="0.16" stroke="#fff" strokeWidth="0.6" fill="none">
        {Array.from({ length: 7 }, (_, i) => (
          <path key={i} d={`M-10 ${28 + i * 26 + seed * 5} Q 90 ${8 + i * 26} 170 ${34 + i * 26} T 330 ${20 + i * 26}`} />
        ))}
      </g>
    </svg>
  );
}
