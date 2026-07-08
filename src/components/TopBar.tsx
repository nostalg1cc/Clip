import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SearchBox, TabList, Tab, Button } from "@fluentui/react-components";
import type { Filter } from "../clipUtils";
// ── Top bar ────────────────────────────────────────────────────────────────────

export function TopBar({
  search, onSearch, filter, onFilter, total, tabs, onClear, emojiIcon,
}: {
  search: string;
  onSearch: (v: string) => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  total: number;
  tabs: { key: Filter; label: string; count?: number }[];
  onClear: () => void;
  emojiIcon: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const clearClick = () => {
    if (confirming) { onClear(); setConfirming(false); }
    else { setConfirming(true); setTimeout(() => setConfirming(false), 2500); }
  };

  return (
    <div className="top-bar">
      <SearchBox
        className="fluent-search"
        size="small"
        appearance="filled-darker"
        placeholder={filter === "emoji" ? "Search emoji…" : "Search clips…"}
        value={search}
        // The bar floats without focus (so pasting never dismisses password
        // popups); clicking the search box asks the backend to take focus so
        // the user can actually type.
        onMouseDown={() => { invoke("focus_search").catch(() => {}); }}
        onChange={(_, d) => onSearch(d.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onSearch(""); e.stopPropagation(); }}
      />

      <div className="top-bar-tabs">
        <TabList
          selectedValue={filter}
          onTabSelect={(_, d) => onFilter(d.value as Filter)}
          size="small"
        >
          {tabs.map(({ key, label, count }) => (
            <Tab
              key={key}
              value={key}
              icon={key === "emoji" ? <span className="tab-emoji-icon">{emojiIcon}</span> : undefined}
            >
              {key === "emoji" ? "Emoji" : label}
              {count !== undefined && count > 0 && <span className="tab-count">{count}</span>}
            </Tab>
          ))}
        </TabList>
      </div>

      {filter !== "emoji" && total > 0 && (
        <Button
          size="small"
          appearance={confirming ? "primary" : "subtle"}
          onClick={clearClick}
        >
          {confirming ? "Clear all?" : "Clear"}
        </Button>
      )}
    </div>
  );
}
