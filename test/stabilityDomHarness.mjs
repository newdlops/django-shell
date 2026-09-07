// Provides a small DOM fixture for staged cell editing and related-table message routing tests.

/** Creates DOM-shaped nodes for functional state tests, without claiming browser rendering coverage. */
export function domFixture() {
  /** Creates a node with the child, event, and selector operations used by the cell editor. */
  function element(tag, props = {}, ...children) {
    const tokens = new Set(), listeners = {};
    const node = {
      tagName: tag.toUpperCase(), children: [], dataset: {}, value: "", _text: "", listeners,
      classList: { add: (...items) => items.forEach((item) => tokens.add(item)), remove: (...items) => items.forEach((item) => tokens.delete(item)), contains: (item) => tokens.has(item) },
      appendChild(child) { if (typeof child === "string") { child = element("span", {}, child); } this.children.push(child); child.parent = this; return child; },
      replaceChildren(...items) { for (const child of this.children) { child.parent = undefined; } this.children = []; this._text = ""; for (const child of items) { this.appendChild(child); } },
      addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
      dispatch(name, event = {}) { for (const listener of listeners[name] || []) { listener({ preventDefault() {}, stopPropagation() {}, target: this, ...event }); } },
      focus() { document.activeElement = this; }, select() {},
      setAttribute(name, value) { this[name] = value; },
      closest(selector) { for (let current = this; current; current = current.parent) { if (matches(current, selector)) { return current; } } return null; },
      querySelectorAll(selector) { return this.children.flatMap((child) => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); },
      set textContent(text) { this.replaceChildren(); this._text = String(text); }
    };
    Object.assign(node, props);
    if (props.className) { for (const token of props.className.split(" ")) { tokens.add(token); } }
    for (const child of children) { if (typeof child === "string") { node._text += child; } else { node.appendChild(child); } }
    return node;
  }
  /** Matches the bounded tag/class selectors used by these functional fixtures. */
  function matches(node, selector) { return selector.split(",").some((part) => { const [tag, cls] = part.trim().split("."); return (!tag || node.tagName.toLowerCase() === tag) && (!cls || node.classList.contains(cls)); }); }
  const document = { createElement: element, createTextNode: (text) => element("span", {}, text) };
  return { document, el: element };
}
