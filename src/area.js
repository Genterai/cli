import { canonicalArgs, recipeId } from "./recipe.js";
import { inferList, pick } from "./shape.js";

// An area kept whole (a repository, a folder): what its prepare run listed and how it read each item, so the area can be
// listed again and compared with its anchors with no model (genter.recipes.reconcile). No anchor type of its own: the list
// call is an ordinary anchor, and so is every item read.
//
// listing = { recipe_id, tool, args, account, list_account, read_tool, shared_args, item_arg, item_field,
//   versions: { value: version }, failed?: { value: tries }, at? }
// account: the account the reads run on (part of each item's anchor id); list_account: the list call's.
// versions: each item read so far with the version the list gave it then ("" when the list has none: a sha, a modified time).
// An item read before whose anchor is no longer there was deleted or forgotten by a person: it is not read again.

export const MAX_TRIES = 3; // an item whose read failed this many times is left out
export const MAX_ITEMS = 5000; // items of one area that are compared at all

// A folder among listed items: a tree or a directory, by its type or mime type.
export const isContainer = (item) => /^(tree|dir|directory|folder)$|\.folder$/i.test(String(item?.type ?? item?.mimeType ?? item?.mime_type ?? item?.kind ?? ""));
// A file that holds no text worth an anchor, by its name: images, media, archives, fonts, binaries, lock files.
export const noText = (value) =>
  typeof value === "string" && /(\.(png|jpe?g|gif|webp|ico|bmp|tiff?|heic|psd|mp[34]|mov|avi|wav|ogg|webm|zip|gz|tgz|tar|rar|7z|jar|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|class|pyc|wasm|lock)|(^|\/)(package-lock\.json|pnpm-lock\.yaml))$/i.test(value);

// What a list call listed: Map(String(value) -> { value, version }) of the items worth reading (no folders, nothing without
// text), the value taken from `field`; version: the item's version field as the list's shape says ("" with none). null: not a list.
export function listedItems(data, field) {
  const shape = inferList(data);
  if (shape.single || !field) return null;
  const items = pick(data, shape.items);
  if (!Array.isArray(items)) return null;
  const versionKey = shape.version && shape.version !== field ? shape.version : null;
  const out = new Map();
  for (const item of items) {
    if (out.size >= MAX_ITEMS) break;
    if (!item || typeof item !== "object" || isContainer(item)) continue;
    const value = pick(item, field);
    if (value == null || value === "" || typeof value === "object" || noText(value)) continue;
    const version = versionKey ? pick(item, versionKey) : null;
    out.set(String(value), { value, version: version == null || typeof version === "object" ? "" : String(version) });
  }
  return out;
}

// The anchor id of the read of one item: the same call always makes the same anchor (recipe.js recipeId).
export const itemId = (listing, value, workspaceId) =>
  recipeId({ workspaceId, scope: listing.account ?? "", tool: listing.read_tool, args: { ...listing.shared_args, [listing.item_arg]: value } });

// The item an anchor reads in this area (its value, as a string), or null when it is not one of the area's reads.
export function itemOf(listing, record, workspaceId) {
  if (!listing?.read_tool || !record || record.tool !== listing.read_tool) return null;
  const value = record.args?.[listing.item_arg];
  if (value == null || typeof value === "object") return null;
  return itemId(listing, value, workspaceId) === record.id ? String(value) : null;
}

// What a reconcile does, with no calls made yet. listed: listedItems of the list call now; existing: Map(value -> { id,
// status }) of the area's anchors; partial: the list was cut (a page, a truncated tree), so what it misses is not gone.
// Returns { read: [value], recheck: [{ id, key }], gone: [{ id, key }], versions, excluded, pending, limited } within `budget`
// calls (new items first, then changed ones); versions holds the baseline for items that already had an anchor.
// room: how many new items the plan has room for (the rest is `limited`: not read, and not pending either).
export function planReconcile({ listing, listed, existing, partial = false, budget = 40, room = Infinity }) {
  const known = listing.versions ?? {};
  const failed = listing.failed ?? {};
  const versions = { ...known };
  const read = [];
  const recheck = [];
  let excluded = 0;
  for (const [key, { value, version }] of listed) {
    const anchor = existing.get(key);
    if (!anchor) {
      if (key in known) excluded++; // read before, its anchor deleted or forgotten since
      else if ((failed[key] ?? 0) < MAX_TRIES) read.push(value);
      continue;
    }
    const before = known[key];
    if (anchor.status === "gone" || anchor.status === "stale") recheck.push({ id: anchor.id, key });
    else if (before !== undefined && before && version && before !== version) recheck.push({ id: anchor.id, key });
    else if (before === undefined) versions[key] = version; // first seen with its anchor: the baseline, no call
  }
  const gone = partial ? [] : [...existing].filter(([key, a]) => !listed.has(key) && a.status !== "gone").map(([key, a]) => ({ id: a.id, key }));
  const allowed = Math.max(0, Math.min(read.length, Number.isFinite(room) ? Math.floor(room) : read.length));
  const limited = read.length - allowed;
  const reads = read.slice(0, Math.min(budget, allowed));
  const rechecks = recheck.slice(0, Math.max(0, budget - reads.length));
  return { read: reads, recheck: rechecks, gone, versions, excluded, pending: allowed - reads.length + recheck.length - rechecks.length, limited };
}

// The listing a prepare run's read_each leaves: the list call's anchor and how each item was read. versions: the items
// whose read worked, with their version; listed: how many items the list call listed (to read), so the unread are known.
export function listingFrom({ recipe, tool, args, account, list_account, read_tool, shared_args, item_arg, item_field, versions = {}, listed }) {
  return {
    recipe_id: recipe,
    tool: tool ?? null,
    args: canonicalArgs(args ?? {}) ?? {},
    account: account ?? "",
    list_account: list_account ?? account ?? "",
    read_tool,
    shared_args: canonicalArgs(shared_args ?? {}) ?? {},
    item_arg: String(item_arg),
    item_field: String(item_field ?? item_arg),
    versions,
    ...(Number.isFinite(listed) && { listed }),
  };
}
