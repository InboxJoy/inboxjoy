"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { useEdition } from "@/components/edition-provider";
import { NavIcon } from "@/components/nav-icon";
import { navItemsForEdition, type NavIcon as NavIconName } from "@/lib/navigation";

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type CommandItem = {
  href: string;
  icon: NavIconName;
  label: string;
  group: "Go to" | "Actions";
  newTab?: boolean;
};

const actionItems: ReadonlyArray<CommandItem> = [
  { href: "/app/sequences/new", icon: "campaigns", label: "New campaign", group: "Actions" },
  { href: "/app/inboxes", icon: "inboxes", label: "Connect mailbox", group: "Actions" },
  { href: "/app/leads", icon: "leads", label: "Import leads", group: "Actions" },
];

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const edition = useEdition();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const commandItems = useMemo<ReadonlyArray<CommandItem>>(() => [
    ...navItemsForEdition(edition).map((item) => ({ ...item, group: "Go to" as const })),
    ...actionItems,
  ], [edition]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery ? commandItems.filter((item) => item.label.toLowerCase().includes(normalizedQuery)) : commandItems;
  }, [commandItems, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(filteredItems.length - 1, 0)));
  }, [filteredItems.length]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onOpenChange, open]);

  if (!open) return null;

  const activate = (item: CommandItem) => {
    onOpenChange(false);
    if (item.newTab) {
      window.open(item.href, "_blank", "noopener");
      return;
    }
    router.push(item.href);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!filteredItems.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => (current + 1) % filteredItems.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => (current - 1 + filteredItems.length) % filteredItems.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selectedItem = filteredItems[selectedIndex];
      if (selectedItem) activate(selectedItem);
    }
  };

  let itemIndex = 0;

  return (
    <div className="cmdk-backdrop" onClick={(event) => event.currentTarget === event.target && onOpenChange(false)}>
      <section className="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input-wrap">
          <svg aria-hidden="true" className="cmdk-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m16.5 16.5 4 4" />
          </svg>
          <input
            aria-activedescendant={filteredItems.length ? `cmdk-option-${selectedIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls="cmdk-results"
            aria-expanded="true"
            aria-label="Search commands"
            autoFocus
            className="cmdk-input"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search pages and actions"
            role="combobox"
            value={query}
          />
          <kbd className="cmdk-key">Esc</kbd>
        </div>

        <div className="cmdk-results" id="cmdk-results" role="listbox" aria-label="Commands">
          {filteredItems.length ? (["Go to", "Actions"] as const).map((group) => {
            const groupItems = filteredItems.filter((item) => item.group === group);
            if (!groupItems.length) return null;

            return (
              <div className="cmdk-group" key={group} role="group" aria-label={group}>
                <div className="cmdk-group-label">{group}</div>
                {groupItems.map((item) => {
                  const index = itemIndex++;
                  const selected = index === selectedIndex;
                  return (
                    <button
                      aria-selected={selected}
                      className="cmdk-item"
                      id={`cmdk-option-${index}`}
                      key={`${group}-${item.href}`}
                      onClick={() => activate(item)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      role="option"
                      type="button"
                    >
                      <span className="cmdk-item-icon"><NavIcon name={item.icon} /></span>
                      <span className="cmdk-item-label">{item.label}</span>
                      {item.newTab ? <span className="cmdk-item-meta">New tab</span> : <span className="cmdk-item-arrow">↵</span>}
                    </button>
                  );
                })}
              </div>
            );
          }) : <p className="cmdk-empty">Nothing matches — try a different word.</p>}
        </div>
      </section>
    </div>
  );
}
