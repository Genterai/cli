import { canonicalArgs } from "./recipe.js";

// How an app's area is listed and read, learned once and kept per app (an area recipe), so the next area of that app is read
// with no model: the list call, the read of one item, the arg each item goes in, the field that names it, and whether the
// list already holds each item's text (list_is_read). It is built from a reading that worked (its listing) and holds tool
// and field names only, never data: an arg whose value is the area's own (an owner, a repository, a folder id) becomes a
// placeholder of the area's `where`, and any other value is kept only when the tool itself gives it as an example, a
// default or an enum value ("main", true, 100); every other value is dropped. Generic: no app has a rule of its own.
//
// recipe = { list_tool, list_args, read_tool, shared_args, item_arg, item_field, list_is_read }
//   list_args / shared_args: { arg: value | "{{where.<key>}}" | "<text with {{where.<key>}}>" }

const PLACEHOLDER = /\{\{where\.([A-Za-z0-9_]+)\}\}/g;
const MAX_TEMPLATE_TEXT = 60; // literal text around a placeholder ("'{{where.folder_id}}' in parents and trashed = false")

// What the tool says a value of this arg may be: its examples, default and enum values.
const offered = (prop) => [prop?.default, ...(Array.isArray(prop?.enum) ? prop.enum : []), ...(Array.isArray(prop?.examples) ? prop.examples : [])].filter((v) => v != null);

// One arg's value as the recipe keeps it, or undefined when it would keep data.
export function templated(value, where = {}, prop = null) {
  const own = Object.entries(where ?? {}).filter(([, v]) => (typeof v === "string" && v.length >= 2) || typeof v === "number");
  const exact = own.find(([, v]) => String(v) === String(value));
  if (exact) return `{{where.${exact[0]}}}`;
  if (typeof value === "boolean" || (typeof value === "number" && offered(prop).length === 0)) return value;
  if (offered(prop).some((v) => v === value || String(v) === String(value))) return value;
  if (typeof value !== "string") return undefined;
  // A text built around the area's own values: kept with placeholders when what is left is short syntax, not data.
  let text = value;
  let placed = false;
  for (const [k, v] of own.sort((a, b) => String(b[1]).length - String(a[1]).length)) {
    if (text.includes(String(v))) {
      text = text.split(String(v)).join(`{{where.${k}}}`);
      placed = true;
    }
  }
  if (!placed) return undefined;
  return text.replace(PLACEHOLDER, "").length <= MAX_TEMPLATE_TEXT ? text : undefined;
}

// Args as the recipe keeps them; null when a required arg would be dropped (the recipe could not make the call again).
function templateArgs(args = {}, where, schema) {
  const props = schema?.properties ?? {};
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v == null || typeof v === "object") continue;
    const kept = templated(v, where, props[k]);
    if (kept !== undefined) out[k] = kept;
  }
  if ((schema?.required ?? []).some((k) => !(k in out) && k in (args ?? {}))) return null;
  return out;
}

// The recipe of a reading that worked: its listing (the list call's tool and args, the read and its args), the area's
// `where`, and the tools' schemas ({ [tool]: inputParameters }). null when it cannot be kept without data.
export function recipeFrom({ listing, where, schemas = {} }) {
  if (!listing?.read_tool || !listing.tool || !listing.item_arg || !where || !Object.keys(where).length) return null;
  const list_args = templateArgs(listing.args, where, schemas[listing.tool]);
  const shared_args = templateArgs(listing.shared_args, where, schemas[listing.read_tool]);
  if (!list_args || !shared_args) return null;
  // A recipe that names nothing of the area would read the same place for every area: not a recipe of an area.
  if (!JSON.stringify([list_args, shared_args]).includes("{{where.")) return null;
  return {
    list_tool: listing.tool,
    list_args: canonicalArgs(list_args) ?? {},
    read_tool: listing.read_tool,
    shared_args: canonicalArgs(shared_args) ?? {},
    item_arg: String(listing.item_arg),
    item_field: String(listing.item_field ?? listing.item_arg),
    ...(listing.list_is_read && { list_is_read: true }),
  };
}

// A recipe filled for one area: the listing a reading starts from (no item read yet), or null when the area lacks a value
// the recipe needs.
export function listingOf(recipe, where = {}, account = "") {
  let missing = false;
  const fill = (args) =>
    Object.fromEntries(
      Object.entries(args ?? {}).map(([k, v]) => [
        k,
        typeof v === "string"
          ? v.replace(PLACEHOLDER, (_, key) => {
              if (where?.[key] == null || where[key] === "") missing = true;
              return String(where?.[key] ?? "");
            })
          : v,
      ]),
    );
  // A value that is the whole placeholder keeps the area's own type (a number stays a number).
  const exact = (args) => Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [k, typeof v === "string" && /^\{\{where\.[A-Za-z0-9_]+\}\}$/.test(v) && where?.[v.slice(8, -2)] != null ? where[v.slice(8, -2)] : v]));
  const args = fill(exact(recipe?.list_args));
  const shared_args = fill(exact(recipe?.shared_args));
  if (missing || !recipe?.list_tool || !recipe.read_tool) return null;
  return {
    tool: recipe.list_tool,
    args,
    account: account ?? "",
    list_account: account ?? "",
    read_tool: recipe.read_tool,
    shared_args,
    item_arg: recipe.item_arg,
    item_field: recipe.item_field ?? recipe.item_arg,
    versions: {},
    ...(recipe.list_is_read && { list_is_read: true }),
  };
}

// The list already holds each item's text: most items carry a text field of their own (a note's body, an issue's
// description), so the list call can be the area's one anchor and no item needs a read. items: the list's items (scalars).
export const LIST_READ_MAX = 100; // items: the list call's anchor keeps one section per item, at most this many
export const LIST_TEXT_CHARS = 200;
export function holdsText(items = [], field = null) {
  if (!items.length || items.length > LIST_READ_MAX) return false;
  const withText = items.filter((i) => Object.entries(i ?? {}).some(([k, v]) => k !== field && typeof v === "string" && v.length >= LIST_TEXT_CHARS && !/^(https?:|data:)/.test(v)));
  return withText.length >= Math.ceil(items.length * 0.8);
}
