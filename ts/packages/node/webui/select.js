// The Desktop app's dropdown (frontend/src/components/Select.tsx), without
// React: a button that looks like a field and a menu that opens from it,
// driven from the keyboard like a native one (arrows, Home/End, Enter/Space,
// Escape, type-ahead).
//
// The native <select> stays in the page, hidden, and remains the source of
// truth: app.js keeps reading and writing `select.value`, toggling
// `select.disabled` and listening for "change" on it. Picking an option sets
// the native value and fires "change"; writing the value, the options' text
// (i18n), `disabled` or the aria-label updates the button.
(function () {
  "use strict";

  const MENU_GAP = 4;
  const MENU_MAX_HEIGHT = 300;
  const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const CHEVRON = `<svg class="nh-select-chevron" width="13" height="13" stroke-width="2" ${SVG}><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>`;
  const CHECK = `<svg width="13" height="13" stroke-width="2.4" ${SVG}><path d="M20 6 9 17l-5-5"/></svg>`;
  const valueProperty = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  let uid = 0;

  function enhance(select) {
    if (select.dataset.nhSelect) return;
    select.dataset.nhSelect = "1";
    const listId = `nh-select-list-${++uid}`;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = `nh-select${select.className ? ` ${select.className}` : ""}`;
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = `<span class="nh-select-value"></span>${CHEVRON}`;
    const valueNode = trigger.firstElementChild;
    select.classList.add("nh-select-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    select.insertAdjacentElement("afterend", trigger);

    let menu = null;
    let activeIndex = -1;
    let typeahead = { text: "", at: 0 };

    const options = () => Array.from(select.options);
    const selectedIndex = () => select.selectedIndex;

    function accessibleName() {
      const aria = select.getAttribute("aria-label");
      if (aria) return aria;
      const label = select.id ? document.querySelector(`label[for="${select.id}"]`) : null;
      return label ? label.textContent.trim() : "";
    }

    function sync() {
      const option = options()[selectedIndex()];
      valueNode.textContent = option ? option.textContent : "";
      trigger.disabled = select.disabled;
      const name = accessibleName();
      if (name) trigger.setAttribute("aria-label", name);
      if (menu) renderMenu();
    }

    // Writes to `select.value` from app.js land here too.
    Object.defineProperty(select, "value", {
      configurable: true,
      get() { return valueProperty.get.call(this); },
      set(next) { valueProperty.set.call(this, next); sync(); },
    });
    new MutationObserver(sync).observe(select, {
      attributes: true,
      attributeFilter: ["disabled", "aria-label"],
      childList: true,
      characterData: true,
      subtree: true,
    });
    // A label pointing at the hidden select opens nothing; send it here.
    if (select.id) {
      const label = document.querySelector(`label[for="${select.id}"]`);
      if (label) label.addEventListener("click", (event) => { event.preventDefault(); trigger.focus(); });
    }

    function choose(index) {
      const option = options()[index];
      if (!option || option.disabled) return;
      close();
      trigger.focus();
      if (option.value === select.value) return;
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function move(from, step) {
      const list = options();
      for (let i = 1; i <= list.length; i += 1) {
        const next = (from + step * i + list.length * 2) % list.length;
        if (!list[next].disabled) return next;
      }
      return from;
    }

    // Under the button, or above it when there is no room below.
    function place() {
      if (!menu) return;
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - MENU_GAP - 8;
      const above = rect.top - MENU_GAP - 8;
      const flip = below < Math.min(MENU_MAX_HEIGHT, 160) && above > below;
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`;
      menu.style.minWidth = `${rect.width}px`;
      menu.style.maxHeight = `${Math.min(MENU_MAX_HEIGHT, flip ? above : below)}px`;
      menu.style.top = flip ? "" : `${rect.bottom + MENU_GAP}px`;
      menu.style.bottom = flip ? `${window.innerHeight - rect.top + MENU_GAP}px` : "";
      menu.style.transformOrigin = flip ? "bottom center" : "top center";
    }

    function renderMenu() {
      const current = selectedIndex();
      menu.replaceChildren(...options().map((option, index) => {
        const row = document.createElement("div");
        row.id = `${listId}-${index}`;
        row.dataset.index = String(index);
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === current));
        if (option.disabled) row.setAttribute("aria-disabled", "true");
        row.className = `nh-select-option${index === activeIndex ? " active" : ""}${option.disabled ? " disabled" : ""}`;
        const check = document.createElement("span");
        check.className = "nh-select-check";
        check.setAttribute("aria-hidden", "true");
        if (index === current) check.innerHTML = CHECK;
        const text = document.createElement("span");
        text.textContent = option.textContent;
        row.append(check, text);
        row.addEventListener("pointermove", () => { if (!option.disabled && activeIndex !== index) setActive(index); });
        row.addEventListener("pointerdown", (event) => event.preventDefault());
        row.addEventListener("click", () => choose(index));
        return row;
      }));
      if (activeIndex >= 0) trigger.setAttribute("aria-activedescendant", `${listId}-${activeIndex}`);
      else trigger.removeAttribute("aria-activedescendant");
    }

    function setActive(index) {
      activeIndex = index;
      renderMenu();
      const row = menu.querySelector(`[data-index="${index}"]`);
      if (row) row.scrollIntoView({ block: "nearest" });
    }

    function onOutside(event) {
      if (trigger.contains(event.target) || (menu && menu.contains(event.target))) return;
      close();
    }

    function open() {
      if (select.disabled || menu || options().length === 0) return;
      const current = selectedIndex();
      activeIndex = current >= 0 ? current : options().findIndex((option) => !option.disabled);
      menu = document.createElement("div");
      menu.className = "nh-select-menu";
      menu.id = listId;
      menu.setAttribute("role", "listbox");
      const name = accessibleName();
      if (name) menu.setAttribute("aria-label", name);
      document.body.appendChild(menu);
      renderMenu();
      place();
      trigger.setAttribute("aria-expanded", "true");
      trigger.setAttribute("aria-controls", listId);
      // Any scroll or resize moves the button; keep the menu attached to it.
      window.addEventListener("pointerdown", onOutside, true);
      window.addEventListener("scroll", place, true);
      window.addEventListener("resize", place);
    }

    function close() {
      if (!menu) return;
      menu.remove();
      menu = null;
      activeIndex = -1;
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-controls");
      trigger.removeAttribute("aria-activedescendant");
      window.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    }

    trigger.addEventListener("click", () => (menu ? close() : open()));
    trigger.addEventListener("keydown", (event) => {
      if (select.disabled) return;
      const key = event.key;
      if (!menu) {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(key)) {
          event.preventDefault();
          open();
        }
        return;
      }
      const count = options().length;
      if (key === "Escape" || key === "Tab") {
        if (key === "Escape") event.preventDefault();
        close();
      } else if (key === "ArrowDown") {
        event.preventDefault();
        setActive(move(activeIndex, 1));
      } else if (key === "ArrowUp") {
        event.preventDefault();
        setActive(move(activeIndex < 0 ? 0 : activeIndex, -1));
      } else if (key === "Home") {
        event.preventDefault();
        setActive(move(-1, 1));
      } else if (key === "End") {
        event.preventDefault();
        setActive(move(count, -1));
      } else if (key === "Enter" || key === " ") {
        event.preventDefault();
        choose(activeIndex);
      } else if (key.length === 1) {
        const now = Date.now();
        const text = (now - typeahead.at < 600 ? typeahead.text : "") + key.toLowerCase();
        typeahead = { text, at: now };
        const match = options().findIndex((option) => !option.disabled && option.textContent.trim().toLowerCase().startsWith(text));
        if (match >= 0) setActive(match);
      }
    });

    sync();
  }

  window.NHGSelect = {
    // Every <select> under `root` (the whole page by default).
    enhanceAll(root) {
      (root || document).querySelectorAll("select").forEach(enhance);
    },
  };
})();
