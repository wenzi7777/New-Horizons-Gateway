// A small Markdown renderer for release notes, the same subset the Desktop
// renders: #/##/### headings, paragraphs, - * and 1. lists (one nesting
// level shown), fenced code, `code`, **bold**, *italic* and [text](url).
//
// Notes are downloaded from GitHub, so they are treated as untrusted: the
// output is built with DOM nodes and textContent only -- no HTML parsing --
// and a link is live only for an absolute http(s) URL.
(function () {
  "use strict";

  const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;

  function appendInline(parent, text) {
    text.split(INLINE).filter(Boolean).forEach((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
        const code = document.createElement("code");
        code.textContent = part.slice(1, -1);
        parent.appendChild(code);
        return;
      }
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        const strong = document.createElement("strong");
        appendInline(strong, part.slice(2, -2));
        parent.appendChild(strong);
        return;
      }
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
        const em = document.createElement("em");
        appendInline(em, part.slice(1, -1));
        parent.appendChild(em);
        return;
      }
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link) {
        const node = /^https?:\/\//i.test(link[2]) ? document.createElement("a") : document.createElement("span");
        if (node.tagName === "A") {
          node.href = link[2];
          node.target = "_blank";
          node.rel = "noreferrer noopener";
        }
        appendInline(node, link[1]);
        parent.appendChild(node);
        return;
      }
      parent.appendChild(document.createTextNode(part));
    });
  }

  function renderMarkdown(source) {
    const root = document.createElement("div");
    root.className = "markdown";
    const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    let paragraph = [];
    let list = null;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const p = document.createElement("p");
      appendInline(p, paragraph.join(" "));
      root.appendChild(p);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      root.appendChild(list.node);
      list = null;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith("```")) {
        flushParagraph();
        flushList();
        const code = [];
        for (i += 1; i < lines.length && !lines[i].startsWith("```"); i += 1) code.push(lines[i]);
        const pre = document.createElement("pre");
        const codeNode = document.createElement("code");
        codeNode.textContent = code.join("\n");
        pre.appendChild(codeNode);
        root.appendChild(pre);
        continue;
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        flushList();
        const node = document.createElement(`h${heading[1].length + 2}`);
        appendInline(node, heading[2]);
        root.appendChild(node);
        continue;
      }
      const item = /^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
      if (item) {
        flushParagraph();
        const ordered = Boolean(item[3]);
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, node: document.createElement(ordered ? "ol" : "ul") };
        }
        const li = document.createElement("li");
        if (item[1].length >= 2) li.className = "md-nested";
        appendInline(li, item[4]);
        list.node.appendChild(li);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      flushList();
      paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    return root;
  }

  window.renderMarkdown = renderMarkdown;
})();
