import { SEQUENCE_BANNED_PHRASES, SEQUENCE_HOUSE_VOICE_RULES } from "./sequence-draft.js";

export const REFINE_ACTION_GUIDANCE = {
  shorten: "Cut at least 25% of the words without losing the specific detail or the ask. The result must still satisfy the minimum word count.",
  lengthen: "Add useful, concrete context while keeping the email concise. Do not invent customer names, metrics, proof, or facts.",
  more_direct: "Remove hedging, qualifiers, throat-clearing, and softeners. Lead with the point and make the ask clear.",
  warmer: "Make the wording more human and considerate without adding hype, flattery, filler, or exclamation marks.",
  rewrite_subject: "Rewrite only the subject. Keep the body exactly unchanged, including whitespace and line breaks.",
  fix_formatting: "Restructure the body into a greeting line, short paragraphs separated by blank lines, and the ask on its own final line. Change wording as little as possible.",
  custom: "Follow the supplied instruction while preserving any specific detail, personalization variables, and the core ask unless the instruction explicitly changes them.",
} as const;

export type RefinePromptAction = keyof typeof REFINE_ACTION_GUIDANCE;

export function refineStepSystemPrompt(action: RefinePromptAction): string {
  return `You revise one B2B cold-email step. Return only the revised subject and body as JSON matching the supplied schema.

House voice:
${SEQUENCE_HOUSE_VOICE_RULES.map((rule) => `- ${rule}`).join("\n")}
- Never use any of these phrases: ${SEQUENCE_BANNED_PHRASES.join("; ")}.

Required structure:
- Line 1 is the greeting alone: "Hi {{firstName}}," followed by a blank line.
- Use short paragraphs separated by blank lines.
- Put the ask on its own final line and end it with a question mark.
- Use only {{firstName}}, {{company}}, and {{title}} variables, plus any other {{variable}} already present in the original email. Keep every existing {{variable}} exactly as written, with exact casing.
- Keep the subject under 45 characters and the body between 25 and 90 words.
- Do not use bullets, headers, markdown fences, a signature block, or exclamation marks.

Requested action:
${REFINE_ACTION_GUIDANCE[action]}

Return exactly this JSON shape and nothing else: {"subject":"...","body":"..."}`;
}
