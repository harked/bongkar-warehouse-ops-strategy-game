/** Tiny DOM helpers for diffed rendering: create once, then touch only what changed. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  parent?: Element | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

const textCache = new WeakMap<Node, string>();
/** Set text only when it differs from what we last wrote. */
export function setText(node: Element, v: string): void {
  if (textCache.get(node) === v) return;
  textCache.set(node, v);
  node.textContent = v;
}

const attrCache = new WeakMap<Element, Record<string, string>>();
export function setAttr(node: Element, name: string, v: string | null): void {
  let c = attrCache.get(node);
  if (!c) attrCache.set(node, (c = {}));
  const key = v ?? '\u0000';
  if (c[name] === key) return;
  c[name] = key;
  if (v === null) node.removeAttribute(name);
  else node.setAttribute(name, v);
}

const styleCache = new WeakMap<Element, Record<string, string>>();
/** Set a style property (or custom property) only when it changed. */
export function setStyle(node: HTMLElement | SVGElement, prop: string, v: string): void {
  let c = styleCache.get(node);
  if (!c) styleCache.set(node, (c = {}));
  if (c[prop] === v) return;
  c[prop] = v;
  node.style.setProperty(prop, v);
}

export function toggle(node: Element, cls: string, on: boolean): void {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
}

const svgTemplates = new Map<string, SVGSVGElement>();
/** Parse SVG markup once per unique string, then clone. */
export function svg(markup: string): SVGSVGElement {
  let t = svgTemplates.get(markup);
  if (!t) {
    const holder = document.createElement('div');
    holder.innerHTML = markup;
    t = holder.firstElementChild as SVGSVGElement;
    svgTemplates.set(markup, t);
  }
  return t.cloneNode(true) as SVGSVGElement;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';
export function svgNode<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(n);
  return n;
}

export interface KeyedRow<T> {
  el: HTMLElement;
  update(item: T): void;
  dispose?(): void;
}

/**
 * Keyed list reconciliation. Rows are created once per key and reused; DOM moves happen only
 * when order actually changes. The container must hold nothing but these rows.
 */
export class KeyedList<T, R extends KeyedRow<T> = KeyedRow<T>> {
  readonly rows = new Map<string, R>();
  constructor(
    private container: HTMLElement,
    private key: (item: T) => string,
    private make: (item: T) => R,
  ) {}

  sync(items: readonly T[]): void {
    const seen = new Set<string>();
    let prev: Element | null = null;
    for (const item of items) {
      const k = this.key(item);
      if (seen.has(k)) continue;
      seen.add(k);
      let r = this.rows.get(k);
      if (!r) {
        r = this.make(item);
        this.rows.set(k, r);
      }
      r.update(item);
      const expected: Element | null = prev ? prev.nextElementSibling : this.container.firstElementChild;
      if (r.el !== expected) this.container.insertBefore(r.el, expected);
      prev = r.el;
    }
    for (const [k, r] of this.rows) {
      if (!seen.has(k)) {
        r.dispose?.();
        r.el.remove();
        this.rows.delete(k);
      }
    }
  }

  get size(): number {
    return this.rows.size;
  }
}
