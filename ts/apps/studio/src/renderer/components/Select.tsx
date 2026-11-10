import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown } from "lucide-react";

/*
 * Ported from New-Horizons-Desktop components/Select.tsx. The app's dropdown: a drop-in for the native select element that takes the same <option>
 * children and calls onChange with an event-like { target: { value } }, so
 * call sites only change the tag name. The menu opens from the button (a
 * popover in a portal, so a modal or a scrolling panel never clips it) and is
 * driven from the keyboard like a native one: arrows, Home/End, Enter/Space,
 * Escape and type-ahead.
 */

export type SelectChangeEvent = { target: { value: string }; currentTarget: { value: string } };

type SelectProps = {
  value?: string | number;
  onChange?: (event: SelectChangeEvent) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  title?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  children?: ReactNode;
};

type SelectOption = { value: string; label: ReactNode; text: string; disabled: boolean };

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

// <option> elements, also inside fragments, arrays and conditionals.
function collectOptions(children: ReactNode, out: SelectOption[] = []): SelectOption[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
    if (element.type === Fragment) {
      collectOptions(element.props.children, out);
    } else if (element.type === "option") {
      const label = element.props.children;
      out.push({
        value: String(element.props.value ?? textOf(label)),
        label,
        text: textOf(label),
        disabled: element.props.disabled === true,
      });
    }
  });
  return out;
}

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 300;

export function Select({ value, onChange, disabled = false, className, id, title, style, children, ...rest }: SelectProps) {
  const options = collectOptions(children);
  const current = value === undefined ? "" : String(value);
  const selectedIndex = options.findIndex((option) => option.value === current);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const listId = useId();

  const choose = useCallback((index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    if (option.value !== current) onChange?.({ target: { value: option.value }, currentTarget: { value: option.value } });
  }, [current, onChange, options]);

  const openMenu = () => {
    if (disabled || options.length === 0) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled));
    setOpen(true);
  };

  // Place the menu under the button, or above it when there is no room below.
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - MENU_GAP - 8;
    const above = rect.top - MENU_GAP - 8;
    const flip = below < Math.min(MENU_MAX_HEIGHT, 160) && above > below;
    setMenuStyle({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
      minWidth: rect.width,
      maxHeight: Math.min(MENU_MAX_HEIGHT, flip ? above : below),
      ...(flip ? { bottom: window.innerHeight - rect.top + MENU_GAP, transformOrigin: "bottom center" } : { top: rect.bottom + MENU_GAP, transformOrigin: "top center" }),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Any scroll or resize moves the button; keep the menu attached to it.
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  // Keep the highlighted option in view while moving through a long list.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menuRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const move = (from: number, step: number) => {
    for (let i = 1; i <= options.length; i += 1) {
      const next = (from + step * i + options.length * 2) % options.length;
      if (!options[next]?.disabled) return next;
    }
    return from;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => move(index, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => move(index < 0 ? 0 : index, -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(move(-1, 1));
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(move(options.length, -1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key.length === 1) {
      const now = Date.now();
      const text = (now - typeahead.current.at < 600 ? typeahead.current.text : "") + event.key.toLowerCase();
      typeahead.current = { text, at: now };
      const match = options.findIndex((option) => !option.disabled && option.text.trim().toLowerCase().startsWith(text));
      if (match >= 0) setActiveIndex(match);
    }
  };

  return (
    <>
      <button
        {...rest}
        ref={triggerRef}
        id={id}
        type="button"
        className={`nh-select${className ? ` ${className}` : ""}`}
        style={style}
        title={title}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="nh-select-value">{selected ? selected.label : current}</span>
        <ChevronsUpDown className="nh-select-chevron" size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      {open
        ? createPortal(
          <div ref={menuRef} className="nh-select-menu" style={menuStyle} role="listbox" id={listId} aria-label={rest["aria-label"]}>
            {options.map((option, index) => (
              <div
                key={`${option.value}-${index}`}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === selectedIndex}
                aria-disabled={option.disabled || undefined}
                className={`nh-select-option${index === activeIndex ? " active" : ""}${option.disabled ? " disabled" : ""}`}
                onPointerMove={() => !option.disabled && setActiveIndex(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span className="nh-select-check" aria-hidden="true">
                  {index === selectedIndex ? <Check size={13} strokeWidth={2.4} /> : null}
                </span>
                <span>{option.label}</span>
              </div>
            ))}
          </div>,
          document.body,
        )
        : null}
    </>
  );
}
