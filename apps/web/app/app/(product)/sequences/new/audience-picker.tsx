import { audienceListCount, audienceTotalLabel, MAX_AUDIENCE_LISTS, toggleAudienceListId, type AudienceList } from "./wizard-state";

export function AudiencePicker({
  lists,
  listIds,
  readyCount,
  onChange,
  legend = "Audience",
  showAllReady = true,
}: {
  lists: AudienceList[];
  listIds: string[];
  readyCount: number;
  onChange: (listIds: string[]) => void;
  legend?: string;
  showAllReady?: boolean;
}) {
  const selectedIds = new Set(listIds);
  const atLimit = listIds.length >= MAX_AUDIENCE_LISTS;

  const toggleList = (listId: string) => {
    onChange(toggleAudienceListId(listIds, listId));
  };

  return <fieldset className="campaign-audience-picker">
    <legend>{legend}</legend>
    <div className="campaign-audience-options">
      {showAllReady ? <label className={listIds.length === 0 ? "is-selected" : undefined}>
        <input checked={listIds.length === 0} name="campaign-audience-all" type="checkbox" onChange={() => onChange([])} />
        <span><strong>All ready leads</strong><small>{readyCount.toLocaleString()} active contacts</small></span>
      </label> : null}
      {lists.map((list) => {
        const selected = selectedIds.has(list.id);
        return <label className={selected ? "is-selected" : undefined} key={list.id}>
          <input checked={selected} disabled={!selected && atLimit} name="campaign-audience-list" type="checkbox" onChange={() => toggleList(list.id)} />
          <span><strong>{list.name}</strong><small>{audienceListCount(list).toLocaleString()} {audienceListCount(list) === 1 ? "contact" : "contacts"}</small></span>
        </label>;
      })}
    </div>
    <p aria-live="polite" className={!showAllReady && listIds.length === 0 ? "campaign-audience-total is-empty" : "campaign-audience-total"}>{!showAllReady && listIds.length === 0 ? "No lists selected" : audienceTotalLabel(listIds, lists, readyCount)}</p>
    {atLimit ? <p className="campaign-audience-limit">You can select up to {MAX_AUDIENCE_LISTS} lists.</p> : null}
  </fieldset>;
}
