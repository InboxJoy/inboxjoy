"use client";

import { useId, useState } from "react";
import { stepVariables, validateNewVariableName, variableOptions, variableToken } from "@/lib/lead-variables";

const NEW_VARIABLE = "__new__";

// Built-in and custom variable names for one email step, shown as {{tokens}} under the editor.
export function VariableChips({ subject, body, stepLabel }: { subject: string; body: string; stepLabel: string }) {
  const { builtIn, custom } = stepVariables({ subject, body });
  if (!builtIn.length && !custom.length) return null;
  return <div className="lead-var-used">
    <span className="polish-mono-label">Variables in this email</span>
    <ul aria-label={`Variables used in ${stepLabel}`} className="lead-var-chips">
      {builtIn.map((name) => <li key={name}><code className="lead-var-chip">{variableToken(name)}</code></li>)}
      {custom.map((name) => <li key={name}><code className="lead-var-chip lead-var-chip--custom" title="Custom variable. Every lead needs a value before launch.">{variableToken(name)}</code></li>)}
    </ul>
  </div>;
}

// Dropdown that inserts {{variable}} at the caret. "New variable…" validates a name first.
export function VariablePicker({ stepLabel, disabled, saved, used, onInsert }: {
  stepLabel: string;
  disabled?: boolean;
  saved: string[];
  used: string[];
  onInsert: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const errorId = useId();
  const options = variableOptions(saved, used);

  const submitNew = () => {
    const check = validateNewVariableName(draft);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    onInsert(check.name);
    setDraft("");
    setError("");
    setCreating(false);
  };

  return <div className="lead-var-picker">
    <label className="lead-var-picker__select">
      <span className="polish-mono-label">Insert variable</span>
      <select aria-label={`Insert variable into ${stepLabel}`} disabled={disabled} value="" onChange={(event) => {
        const value = event.target.value;
        if (value === NEW_VARIABLE) { setCreating(true); return; }
        if (value) onInsert(value);
      }}>
        <option value="">Choose…</option>
        <optgroup label="Standard">{options.builtIn.map((name) => <option key={name} value={name}>{variableToken(name)}</option>)}</optgroup>
        {options.custom.length ? <optgroup label="Custom">{options.custom.map((name) => <option key={name} value={name}>{variableToken(name)}</option>)}</optgroup> : null}
        <option value={NEW_VARIABLE}>New variable…</option>
      </select>
    </label>
    {creating ? <div className="lead-var-new">
      <input aria-describedby={error ? errorId : undefined} aria-invalid={Boolean(error)} aria-label={`New variable name for ${stepLabel}`} autoFocus maxLength={70} placeholder="icebreaker" value={draft} onChange={(event) => { setDraft(event.target.value); setError(""); }} onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); submitNew(); }
        if (event.key === "Escape") { event.preventDefault(); setCreating(false); setError(""); }
      }} />
      <button className="ij-button ij-button--secondary" type="button" onClick={submitNew}>Insert</button>
      <button className="ij-button ij-button--ghost" type="button" onClick={() => { setCreating(false); setError(""); setDraft(""); }}>Cancel</button>
      {error ? <p className="lead-var-new__error" id={errorId} role="alert">{error}</p> : null}
    </div> : null}
  </div>;
}
