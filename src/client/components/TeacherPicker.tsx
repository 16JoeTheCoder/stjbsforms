import { useCombobox } from "downshift";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { searchTeachers, teacherDisplayName } from "../../shared/search";
import type { PublicTeacher } from "../../shared/types";

interface Props {
  id: string;
  label: string;
  teachers: PublicTeacher[];
  value: string | null;
  onChange: (teacherId: string | null) => void;
  /** teacherId -> where it's already used, e.g. "Most Likely to Never Retire" */
  unavailable?: Map<string, string>;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  hideLabel?: boolean;
}

/**
 * Accessible teacher combobox built on Downshift (WAI-ARIA 1.2 combobox).
 * Only roster entries can be selected; free text never becomes a value.
 */
export function TeacherPicker({
  id,
  label,
  teachers,
  value,
  onChange,
  unavailable,
  invalid,
  describedBy,
  placeholder = "Type a teacher's name",
  hideLabel,
}: Props) {
  const selected = useMemo(() => teachers.find((t) => t.id === value) ?? null, [teachers, value]);
  const [query, setQuery] = useState(selected ? teacherDisplayName(selected) : "");
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ teachers, value });
  latest.current = { teachers, value };

  const items = useMemo(() => {
    const q = selected && query === teacherDisplayName(selected) ? "" : query;
    return searchTeachers(teachers, q);
  }, [teachers, query, selected]);

  const {
    isOpen,
    getMenuProps,
    getInputProps,
    getItemProps,
    getLabelProps,
    getToggleButtonProps,
    highlightedIndex,
    openMenu,
    selectItem,
  } = useCombobox<PublicTeacher>({
    id,
    items,
    selectedItem: selected,
    inputValue: query,
    itemToString: (t) => (t ? teacherDisplayName(t) : ""),
    isItemDisabled: (t) => Boolean(unavailable?.has(t.id)),
    // Highlight the first selectable match, never an already-used teacher.
    defaultHighlightedIndex: Math.max(0, items.findIndex((t) => !unavailable?.has(t.id))),
    onInputValueChange: ({ inputValue, type }) => {
      if (type !== useCombobox.stateChangeTypes.InputChange) setQuery(inputValue ?? "");
    },
    onSelectedItemChange: ({ selectedItem }) => {
      onChange(selectedItem?.id ?? null);
      setQuery(selectedItem ? teacherDisplayName(selectedItem) : "");
    },
    stateReducer: (state, { type, changes }) => {
      // Belt and braces: a teacher already used elsewhere can never become the value.
      if (changes.selectedItem && changes.selectedItem !== state.selectedItem && unavailable?.has(changes.selectedItem.id)) {
        return { ...changes, selectedItem: state.selectedItem, inputValue: state.inputValue, isOpen: true };
      }
      // Leaving the field never selects anything implicitly; text that isn't a
      // roster selection snaps back to the current value.
      if (type === useCombobox.stateChangeTypes.InputBlur) {
        return {
          ...changes,
          selectedItem: state.selectedItem,
          inputValue: state.selectedItem ? teacherDisplayName(state.selectedItem) : "",
        };
      }
      return changes;
    },
  });

  // Keep the input text in sync when the value changes from outside.
  const shown = selected ? teacherDisplayName(selected) : "";
  const lastValue = useRef(value);
  if (lastValue.current !== value) {
    lastValue.current = value;
    if (query !== shown) setQuery(shown);
  }

  return (
    <div className="relative">
      <label {...getLabelProps()} className={clsx("label mb-1.5", hideLabel && "sr-only")}>
        {label}
      </label>
      <div
        className={clsx(
          "flex items-center rounded-xl border bg-card transition-[border-color,box-shadow] duration-150 focus-within:border-ink focus-within:ring-2 focus-within:ring-ink/15",
          invalid ? "border-bad" : selected ? "border-ink/60" : "border-line-strong",
        )}
      >
        <Search aria-hidden className="ml-3.5 size-4 shrink-0 text-muted" />
        <input
          {...getInputProps({
            ref: inputRef,
            // Update the filter synchronously: Downshift's onInputValueChange runs in an
            // effect, so a fast Enter could otherwise act on the previous result list.
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
              setQuery(e.target.value);
              if (e.target.value === "" && value) onChange(null);
            },
            // Downshift only handles blur while the menu is open; after Escape the typed
            // text would linger. Snap back to the real selection whenever focus leaves.
            onBlur: () => {
              setTimeout(() => {
                if (document.activeElement === inputRef.current) return;
                const { teachers: ts, value: v } = latest.current;
                const sel = ts.find((t) => t.id === v);
                setQuery(sel ? teacherDisplayName(sel) : "");
              }, 0);
            },
            onFocus: () => {
              if (!isOpen) openMenu();
              if (window.innerWidth < 640) {
                // keep the field and its list above the on-screen keyboard
                setTimeout(() => inputRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 250);
              }
            },
            "aria-invalid": invalid || undefined,
            "aria-describedby": describedBy,
          })}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="words"
          spellCheck={false}
          enterKeyHint="done"
          className="h-12 min-w-0 flex-1 scroll-mt-4 bg-transparent px-2.5 text-[16px] text-ink placeholder:text-muted focus:outline-none"
        />
        {selected ? (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => {
              selectItem(null);
              inputRef.current?.focus();
            }}
            className="mr-1 grid size-9 place-items-center rounded-full text-muted hover:bg-paper-2 hover:text-ink"
          >
            <X className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          {...getToggleButtonProps()}
          aria-label={`Show teachers for ${label}`}
          className="mr-1.5 grid size-9 place-items-center rounded-full text-muted hover:bg-paper-2 hover:text-ink"
        >
          <ChevronDown className={clsx("size-4 transition-transform duration-150", isOpen && "rotate-180")} />
        </button>
      </div>
      <ul
        {...getMenuProps()}
        className={clsx(
          "absolute inset-x-0 top-full z-30 mt-1.5 max-h-[min(18rem,45vh)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-card p-1 shadow-[var(--shadow-lift)]",
          !isOpen && "hidden",
        )}
      >
        {isOpen && items.length === 0 ? (
          <li className="px-3 py-3 text-sm text-muted">No teacher matches “{query}”. Check the spelling or try a first name.</li>
        ) : null}
        {isOpen &&
          items.map((t, index) => {
            const usedFor = unavailable?.get(t.id);
            const isSel = t.id === value;
            return (
              <li
                key={t.id}
                {...getItemProps({ item: t, index })}
                className={clsx(
                  "flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-[15px]",
                  highlightedIndex === index && !usedFor && "bg-paper-2",
                  usedFor && "cursor-not-allowed text-muted",
                )}
              >
                <span className="min-w-0">
                  <span className={clsx("block truncate", isSel && "font-semibold")}>{teacherDisplayName(t)}</span>
                  {usedFor ? <span className="block truncate text-xs text-muted">Already chosen · {usedFor}</span> : null}
                </span>
                {isSel ? <Check aria-hidden className="size-4 shrink-0" /> : null}
              </li>
            );
          })}
      </ul>
    </div>
  );
}
