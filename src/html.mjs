// A small HTML parser and selector engine.
//
// The plugin ships with zero runtime dependencies, so a clean install needs no
// package step. It supports only what vacancy reading actually needs: tag,
// class, id and attribute selectors (including *=), descendant combinators,
// text extraction, attribute access and element cloning.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);
const HEAD_TAGS = new Set(['title', 'meta', 'link', 'base']);

export const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', bull: '•',
  middot: '·', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', pound: '£', euro: '€',
  yen: '¥', deg: '°', laquo: '«', raquo: '»', times: '×', divide: '÷', dash: '–' };
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const key = name.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

class Element {
  constructor(tag) { this.type = 'tag'; this.tag = tag; this.attribs = {}; this.children = []; this.parent = null; }
}
class TextNode {
  constructor(value) { this.type = 'text'; this.value = value; this.parent = null; }
}
class Root {
  constructor() { this.type = 'root'; this.children = []; this.parent = null; }
}

function addText(parent, value) {
  if (!value) return;
  const node = new TextNode(decodeEntities(value));
  node.parent = parent;
  parent.children.push(node);
}

function parseTag(src, start) {
  let i = start + 1;
  while (i < src.length && !/[\s/>]/.test(src[i])) i++;
  const attribs = {};
  let selfClosing = false;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === '>') { i++; break; }
    if (src[i] === '/' && src[i + 1] === '>') { selfClosing = true; i += 2; break; }
    if (src[i] === '/') { i++; continue; }
    let name = '';
    while (i < src.length && !/[\s=/>]/.test(src[i])) name += src[i++];
    if (!name) { i++; continue; }
    name = name.toLowerCase();
    while (i < src.length && /\s/.test(src[i])) i++;
    let value = '';
    if (src[i] === '=') {
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const quote = src[i];
      if (quote === '"' || quote === "'") {
        i++;
        const end = src.indexOf(quote, i);
        value = end === -1 ? src.slice(i) : src.slice(i, end);
        i = end === -1 ? src.length : end + 1;
      } else {
        while (i < src.length && !/[\s>]/.test(src[i])) value += src[i++];
      }
    }
    attribs[name] = decodeEntities(value);
  }
  return { attribs, selfClosing, end: i };
}

function parseHtml(html) {
  const root = new Root();
  const stack = [root];
  const src = String(html ?? '');
  const top = () => stack[stack.length - 1];
  const popTo = tag => { for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { stack.length = k; return true; } return false; };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { addText(top(), src.slice(i)); break; }
    if (lt > i) addText(top(), src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end === -1 ? src.length : end).trim().toLowerCase();
      popTo(name);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const head = /^<([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(src.slice(lt));
    if (!head) { addText(top(), '<'); i = lt + 1; continue; }
    const tag = head[1].toLowerCase();
    const { attribs, selfClosing, end } = parseTag(src, lt);
    const element = new Element(tag);
    element.attribs = attribs;
    top().children.push(element);
    element.parent = top();
    if (RAW_TEXT_TAGS.has(tag) && !selfClosing) {
      const closeAt = src.toLowerCase().indexOf('</' + tag, end);
      const raw = closeAt === -1 ? src.slice(end) : src.slice(end, closeAt);
      if (raw) { const node = new TextNode(raw); node.parent = element; element.children.push(node); }
      popTo(tag);
      if (closeAt === -1) { i = src.length; }
      else { const gt = src.indexOf('>', closeAt); i = gt === -1 ? src.length : gt + 1; }
      continue;
    }
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
    i = end;
  }
  return root;
}

// Documents are presented as html > head + body, like a browser would.
function buildDocument(root) {
  const html = new Element('html');
  const head = new Element('head');
  const body = new Element('body');
  const place = node => {
    if (node.type === 'tag' && node.tag === 'html') { for (const child of node.children) place(child); return; }
    if (node.type === 'tag' && node.tag === 'body') { for (const child of node.children) place(child); return; }
    const target = node.type === 'tag' && HEAD_TAGS.has(node.tag) ? head : body;
    target.children.push(node);
    node.parent = target;
  };
  for (const child of root.children) place(child);
  html.children.push(head, body);
  head.parent = html;
  body.parent = html;
  root.children = [html];
  html.parent = root;
  return root;
}

// --- selectors ---------------------------------------------------------------
function parseCompound(token) {
  const spec = { tag: null, classes: [], id: null, attrs: [] };
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(token))) {
    if (m[1]) spec.tag = m[1].toLowerCase();
    else if (m[2]) spec.classes.push(m[2]);
    else if (m[3]) spec.id = m[3];
    else if (m[4]) {
      const raw = m[4].trim();
      const am = /^([\w-]+)\s*(?:([*^$~|]?=)\s*(.*))?$/.exec(raw);
      if (!am) continue;
      let value = am[3] ?? '';
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      spec.attrs.push({ name: am[1].toLowerCase(), op: am[2] ?? null, value });
    }
  }
  return spec;
}
export function parseSelector(selector) {
  return String(selector ?? '').split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const steps = part.split(/\s+/).filter(Boolean).map(parseCompound);
    return steps.length ? steps : null;
  }).filter(Boolean);
}
function matchCompound(element, spec) {
  if (!element || element.type !== 'tag') return false;
  if (spec.tag && element.tag !== spec.tag) return false;
  if (spec.id != null && element.attribs.id !== spec.id) return false;
  if (spec.classes.length) {
    const classes = String(element.attribs.class ?? '').split(/\s+/).filter(Boolean);
    if (!spec.classes.every(c => classes.includes(c))) return false;
  }
  for (const attr of spec.attrs) {
    const actual = element.attribs[attr.name];
    if (actual === undefined) return false;
    if (!attr.op) continue;
    if (attr.op === '=' && actual !== attr.value) return false;
    if (attr.op === '*=' && !actual.includes(attr.value)) return false;
    if (attr.op === '^=' && !actual.startsWith(attr.value)) return false;
    if (attr.op === '$=' && !actual.endsWith(attr.value)) return false;
    if (attr.op === '~=' && !actual.split(/\s+/).includes(attr.value)) return false;
  }
  return true;
}
function matchSteps(element, steps) {
  const last = steps[steps.length - 1];
  if (!matchCompound(element, last)) return false;
  let cursor = element.parent;
  for (let s = steps.length - 2; s >= 0; s--) {
    let found = null;
    while (cursor) {
      if (matchCompound(cursor, steps[s])) { found = cursor; break; }
      cursor = cursor.parent;
    }
    if (!found) return false;
    cursor = found.parent;
  }
  return true;
}
function descendants(node, out = []) {
  for (const child of node.children ?? []) { out.push(child); descendants(child, out); }
  return out;
}
export function select(node, selector) {
  const groups = parseSelector(selector);
  const all = descendants(node).filter(el => el.type === 'tag');
  return all.filter(el => groups.some(steps => matchSteps(el, steps)));
}
export function textOfNode(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  if (node.type !== 'tag' && node.type !== 'root') return '';
  let out = '';
  for (const child of node.children) out += textOfNode(child);
  return out;
}
function cloneNode(node) {
  if (node.type === 'text') { const copy = new TextNode(node.value); copy.parent = null; return copy; }
  const copy = new Element(node.tag);
  copy.attribs = { ...node.attribs };
  for (const child of node.children) { const c = cloneNode(child); c.parent = copy; copy.children.push(c); }
  return copy;
}

// --- the small selection surface used by this runtime ------------------------
class Selection {
  constructor(elements, doc) { this.elements = elements; this.doc = doc; }
  get length() { return this.elements.length; }
  each(fn) { this.elements.forEach((element, index) => fn(index, element)); return this; }
  toArray() { return [...this.elements]; }
  first() { return new Selection(this.elements.slice(0, 1), this.doc); }
  text() { return this.elements.map(textOfNode).join(''); }
  attr(name) { return this.elements.length ? this.elements[0].attribs?.[name] : undefined; }
  find(selector) {
    const out = [];
    for (const element of this.elements) for (const found of select(element, selector)) if (!out.includes(found)) out.push(found);
    return new Selection(out, this.doc);
  }
  closest(selector) {
    const out = [];
    for (const element of this.elements) {
      let cursor = element;
      while (cursor) {
        const groups = parseSelector(selector);
        if (groups.some(steps => matchSteps(cursor, steps))) { out.push(cursor); break; }
        cursor = cursor.parent;
      }
    }
    return new Selection(out, this.doc);
  }
  remove() {
    for (const element of this.elements) {
      const parent = element.parent;
      if (!parent) continue;
      const index = parent.children.indexOf(element);
      if (index >= 0) parent.children.splice(index, 1);
      element.parent = null;
    }
    return this;
  }
  clone() { return new Selection(this.elements.map(cloneNode), this.doc); }
  root() { return new Selection([this.doc.root], this.doc); }
  html() { return this.elements.map(node => node.children.map(textOfNode).join('')).join(''); }
}

export function load(html) {
  const root = buildDocument(parseHtml(html));
  const doc = { root };
  const $ = selector => {
    if (selector == null) return new Selection([], doc);
    if (typeof selector === 'object') return new Selection([selector], doc);
    return new Selection(select(root, selector), doc);
  };
  $.root = () => new Selection([root], doc);
  $.text = () => textOfNode(root);
  $.html = () => textOfNode(root);
  return $;
}
