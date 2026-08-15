"use strict";

// A deliberately small DOM for testing settings/index.html, and deliberately a
// strict one: anything the page uses that is not implemented here throws rather
// than quietly returning undefined.
//
// That strictness is the whole point. A permissive shim is a stub that can be
// wrong in the same direction as the code it guards — which is exactly how the
// settings-page bugs got through — so this one fails loudly instead of
// pretending.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PAGE = path.join(__dirname, "..", "settings", "index.html");

// Properties the page is allowed to set on an element. Anything else is either
// a typo or a feature this shim has not been taught, and both should fail.
const ALLOWED = new Set([
  "className",
  "disabled",
  "max",
  "min",
  "onchange",
  "onclick",
  "selected",
  "step",
  "textContent",
  "title",
  "type",
  "value",
]);

class Element {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.style = {};
    this.parentNode = null;
    this.className = "";
    this.text = "";

    return new Proxy(this, {
      set(target, property, value) {
        if (typeof property === "string" && property.startsWith("_")) {
          target[property] = value;
          return true;
        }
        if (property === "textContent") {
          target.text = value == null ? "" : String(value);
          target.childNodes = [];
          return true;
        }
        if (property === "innerHTML") {
          if (value === "") {
            target.childNodes = [];
            target.text = "";
            return true;
          }
          // Entities only. Markup here would be an injection route for a device
          // name, and the page has no business building any.
          if (/^(?:&[a-z]+;|\s)+$/.test(String(value))) {
            target.text = String(value);
            return true;
          }
          throw new Error(`innerHTML with markup is not supported: ${value}`);
        }
        if (!ALLOWED.has(property) && !(property in target)) {
          throw new Error(`Unsupported property on <${target.tagName}>: ${String(property)}`);
        }
        target[property] = value;
        return true;
      },
      get(target, property) {
        if (property === "textContent") {
          if (target.childNodes.length === 0) return target.text;
          return target.childNodes.map((child) => child.textContent).join("");
        }
        if (property === "innerHTML") return target.text;
        return target[property];
      },
    });
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  setAttribute(name, value) {
    this.attributes[String(name)] = String(value);
  }

  getAttribute(name) {
    const value = this.attributes[String(name)];
    return value === undefined ? null : value;
  }

  // <table> only, and only the two methods the mapping table uses.
  insertRow() {
    if (this.tagName !== "TABLE") {
      throw new Error(`insertRow on <${this.tagName}>`);
    }
    return this.appendChild(new Element("tr"));
  }

  insertCell() {
    if (this.tagName !== "TR") {
      throw new Error(`insertCell on <${this.tagName}>`);
    }
    return this.appendChild(new Element("td"));
  }
}

// The ids the page looks up. Asserted against the real markup by the suite, so
// renaming one in the HTML without renaming it here fails rather than silently
// testing a document the page never sees.
const PAGE_IDS = ["zones", "defaults", "daylight", "offbelow", "autofill", "weather"];

function createDocument() {
  const byId = {};
  for (const id of PAGE_IDS) {
    byId[id] = new Element(id === "offbelow" ? "input" : id === "autofill" ? "button" : "div");
  }
  return {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => {
      if (byId[id] === undefined) {
        throw new Error(`getElementById("${id}") — not a known element of the page`);
      }
      return byId[id];
    },
  };
}

// Evaluates the page's inline script. A syntax error in it fails here, which is
// a check worth having on its own.
function loadPage() {
  const html = fs.readFileSync(PAGE, "utf8");
  const match = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
  if (match == null) {
    throw new Error("no inline script found in settings/index.html");
  }
  const document = createDocument();
  const sandbox = { document, console };
  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox, { filename: "settings/index.html" });
  if (typeof sandbox.onHomeyReady !== "function") {
    throw new Error("the page does not define onHomeyReady");
  }
  return { sandbox, document };
}

// --------------------------------------------------------------- test helpers

// Every element under `root` matching a predicate, depth first.
function all(root, predicate) {
  const found = [];
  const walk = (node) => {
    if (predicate(node)) found.push(node);
    node.childNodes.forEach(walk);
  };
  walk(root);
  return found;
}

const byTag = (root, tagName) => all(root, (node) => node.tagName === tagName.toUpperCase());
const byClass = (root, className) => all(root, (node) => node.className === className);

const contains = (root, needle) => all(root, (node) => node === needle).length > 0;

// The label a .dayfield carries, paired with the control inside it.
function fields(block) {
  return byClass(block, "dayfield").map((wrap) => ({
    label: wrap.childNodes[0].textContent,
    control: wrap.childNodes[1],
  }));
}

const field = (block, label) => fields(block).filter((entry) => entry.label === label)[0];

module.exports = { PAGE, PAGE_IDS, all, byClass, byTag, contains, field, fields, loadPage };
