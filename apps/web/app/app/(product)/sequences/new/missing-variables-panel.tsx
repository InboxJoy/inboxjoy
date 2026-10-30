import { Button, Card } from "@inboxjoy/ui";
import { MISSING_VARIABLES_JOIN_NOTE, MISSING_VARIABLES_NEXT_STEP, missingVariablesBreakdown, missingVariablesHeadline, missingVariablesSamples, type MissingVariablesSummary } from "./missing-variables";

function Details({ summary }: { summary: MissingVariablesSummary }) {
  const breakdown = missingVariablesBreakdown(summary);
  const samples = missingVariablesSamples(summary);
  return <>
    {breakdown.length ? <ul>{breakdown.map((line) => <li key={line}>{line}</li>)}</ul> : null}
    {samples.emails.length ? <ul className="ph-mask">{samples.emails.map((email) => <li key={email}>{email}</li>)}{samples.moreLabel ? <li>{samples.moreLabel}</li> : null}</ul> : null}
  </>;
}

// Launch blocker: shown after a launch/publish attempt fails with `missing_variables`.
export function MissingVariablesBlocker({ summary, onReview, reviewHint }: { summary: MissingVariablesSummary; onReview?: () => void; reviewHint?: string }) {
  return <Card className="campaign-launch-result campaign-launch-result--error">
    <div><strong>{missingVariablesHeadline(summary)}</strong><p role="alert">{MISSING_VARIABLES_NEXT_STEP} {MISSING_VARIABLES_JOIN_NOTE}</p></div>
    <Details summary={summary} />
    {onReview ? <div><Button variant="secondary" onClick={onReview}>Fill in missing values</Button></div> : reviewHint ? <p>{reviewHint}</p> : null}
  </Card>;
}

// Early, non-blocking warning shown next to the audience count before launch.
export function MissingVariablesWarning({ summary, onReview, reviewHint }: { summary: MissingVariablesSummary; onReview?: () => void; reviewHint?: string }) {
  return <div className="campaign-eligible-note" role="status">
    <strong>{missingVariablesHeadline(summary)}</strong>
    <p style={{ margin: "4px 0 8px" }}>Launch waits until every lead has a value. {MISSING_VARIABLES_NEXT_STEP} {MISSING_VARIABLES_JOIN_NOTE}</p>
    <Details summary={summary} />
    {onReview ? <Button variant="secondary" onClick={onReview}>Fill in missing values</Button> : reviewHint ? <p style={{ margin: 0 }}>{reviewHint}</p> : null}
  </div>;
}
