/*
 * CLion's toolbar in VS Code's title bar: the CMake profile and target, then
 * Build, Run and Debug, next to the command center. An extension can't put
 * anything in the title bar, so CMake Helper copies this script next to VS
 * Code's workbench.html and adds it there (src/titleBar.ts). It draws nothing
 * of its own: it mirrors the extension's status bar items (text, icon,
 * tooltip, colours) and a click on one clicks the item, so the extension
 * keeps all the logic. While it's shown, those status bar items are hidden.
 * Plain DOM, no innerHTML: the workbench requires trusted types.
 */
(() => {
  const PREFIX = "cernik.vs-code-cmake-helper.cmakeHelper.";
  /** The mirrored items, in the toolbar's order; `group` items share one bordered box, like CLion's run configuration. */
  const ITEMS = [
    { id: "reload", kind: "text" },
    { id: "profile", kind: "text", group: true },
    { id: "target", kind: "text", group: true },
    { id: "build", kind: "icon" },
    { id: "run", kind: "icon", color: "run" },
    { id: "debug", kind: "icon", color: "run" },
  ];

  const css = `
body.cmake-helper-toolbar ${ITEMS.map((i) => `#${CSS.escape(PREFIX + i.id)}`).join(", ")} { display: none !important; }
/* Above the title bar's drag region, as VS Code's own toolbars are. */
.cmake-helper-toolbar-bar { position: relative; z-index: 2500; display: flex; align-items: center; gap: 2px; height: 100%; padding: 0 6px; -webkit-app-region: no-drag; app-region: no-drag; }
.cmake-helper-toolbar-bar button { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 5px; border: 0; border-radius: 5px; background: none;
  color: inherit; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; max-width: 220px; }
.cmake-helper-toolbar-bar button:hover { background: var(--vscode-toolbar-hoverBackground); }
.cmake-helper-toolbar-bar button .label { overflow: hidden; text-overflow: ellipsis; }
.cmake-helper-toolbar-bar button.icon { width: 24px; justify-content: center; padding: 0; }
.cmake-helper-toolbar-bar button.run .codicon { color: var(--vscode-debugIcon-startForeground, #89d185); }
.cmake-helper-toolbar-bar button .chevron { opacity: .7; font-size: 12px; }
.cmake-helper-toolbar-bar .group { display: flex; align-items: center; height: 22px; margin-right: 4px; border: 1px solid var(--vscode-commandCenter-border, rgba(128,128,128,.35)); border-radius: 6px; }
.cmake-helper-toolbar-bar .group button { border-radius: 0; height: 20px; }
.cmake-helper-toolbar-bar .group button:first-child { border-radius: 5px 0 0 5px; }
.cmake-helper-toolbar-bar .group button:last-child { border-radius: 0 5px 5px 0; }
.cmake-helper-toolbar-bar .group button + button { border-left: 1px solid var(--vscode-commandCenter-border, rgba(128,128,128,.35)); }
`;

  /** The status bar item's own clickable label, if the extension shows it now. */
  const original = (id) => document.getElementById(PREFIX + id)?.querySelector("a.statusbar-item-label");

  /** "play, Run test (Shift+F10)": the tooltip part of VS Code's aria-label (the part before is the icon's name). */
  const tooltipOf = (a) => {
    const label = a.getAttribute("aria-label") ?? "";
    const i = label.indexOf(", ");
    return i >= 0 ? label.slice(i + 2) : label;
  };

  function button(item, a) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = [item.kind, item.color ?? ""].join(" ").trim();
    b.title = tooltipOf(a);
    b.setAttribute("aria-label", b.title);
    // The icon (a codicon span, VS Code's own font) and the text, as the item shows them.
    const icon = a.querySelector(".codicon")?.cloneNode(true);
    if (icon) b.append(icon);
    const text = a.textContent.trim();
    if (item.kind === "text" && text) {
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = text;
      b.append(label);
      if (item.group) {
        const chevron = document.createElement("span");
        chevron.className = "codicon codicon-chevron-down chevron";
        b.append(chevron);
      }
    }
    // A warning-coloured item (Reload CMake) keeps its colours.
    const box = a.parentElement;
    if (box?.style.backgroundColor) b.style.backgroundColor = box.style.backgroundColor;
    if (box?.style.color || a.style.color) b.style.color = box.style.color || a.style.color;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      original(item.id)?.click();
    });
    return b;
  }

  let bar = null;
  let last = "";

  function render() {
    const right = document.querySelector(".part.titlebar .titlebar-right");
    const present = ITEMS.map((item) => ({ item, a: original(item.id) })).filter((x) => x.a);
    // No project (or no title bar): the status bar shows whatever there is.
    if (!right || !present.length) {
      bar?.remove();
      bar = null;
      last = "";
      document.body.classList.remove("cmake-helper-toolbar");
      return;
    }
    // Rebuild only when something shown changed.
    const key = present.map(({ item, a }) => `${item.id}\u0000${a.outerHTML}\u0000${a.parentElement?.getAttribute("style") ?? ""}`).join("\u0001");
    if (bar && bar.isConnected && key === last) return;
    last = key;
    if (!bar || !bar.isConnected) {
      bar = document.createElement("div");
      bar.className = "cmake-helper-toolbar-bar";
      right.prepend(bar);
    }
    bar.replaceChildren();
    let group = null;
    for (const { item, a } of present) {
      const b = button(item, a);
      if (item.group) {
        if (!group) {
          group = document.createElement("div");
          group.className = "group";
          bar.append(group);
        }
        group.append(b);
      } else {
        group = null;
        bar.append(b);
      }
    }
    document.body.classList.add("cmake-helper-toolbar");
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  };

  function start() {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    // The status bar changes (items come, go and change text) and the title bar may be redrawn: follow both.
    new MutationObserver((records) => {
      if (bar && records.every((r) => bar.contains(r.target))) return;
      schedule();
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "style", "class"] });
    schedule();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
