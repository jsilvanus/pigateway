/**
 * Rights are `<module>:<level>`. Levels: read, write, operate, admin. `admin` includes the other three and every level
 * includes `read`, but `write` and `operate` are independent (a right is only ever granted explicitly).
 * `*` stands for every Pi module; it never includes the `canva` or `sissi` modules, which a group has to name itself.
 */
export const LEVELS = ["read", "write", "operate", "admin"] as const;
export type Level = (typeof LEVELS)[number];

/** Modules the `*` wildcard covers: all Pi modules (so not canva, not sissi). */
const LIVE_MODULES = ["matrix", "pivoice", "piencoder", "pitube", "picam", "piswitch"];

const PRESETS: Record<string, string[]> = {
  "@viewer": ["*:read"],
  "@operator": ["*:read", ...LIVE_MODULES.map((m) => `${m}:operate`), "canva:operate"],
  "@content": ["*:read", "piprogram:write", "canva:write"],
  "@admin": ["*:admin", "canva:admin"]
};

const RIGHT = /^([a-z][a-z0-9-]*|\*):(read|write|operate|admin)$/;

/** group name -> rights. Group names are the parish's own and live only in the deploy environment. */
export type GroupRights = Map<string, Set<string>>;

/** Parses `<group>=<right|@preset>[,<right|@preset>...];<group>=...`. Throws on a malformed entry so a typo cannot silently grant or drop access. */
export function parseGroupRights(value: string | undefined): GroupRights {
  const map: GroupRights = new Map();
  for (const entry of (value ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`PIGATEWAY_OIDC_GROUP_RIGHTS: expected <group>=<rights>, got an entry without a group`);
    const group = entry.slice(0, eq).trim();
    const set = map.get(group) ?? new Set<string>();
    for (const item of entry.slice(eq + 1).split(",").map((s) => s.trim()).filter(Boolean)) {
      const expanded = item.startsWith("@") ? PRESETS[item] : [item];
      if (!expanded) throw new Error(`PIGATEWAY_OIDC_GROUP_RIGHTS: unknown preset ${item}`);
      for (const right of expanded) {
        if (!RIGHT.test(right)) throw new Error(`PIGATEWAY_OIDC_GROUP_RIGHTS: invalid right "${right}" (use <module>:<read|write|operate|admin>)`);
        set.add(right);
      }
    }
    map.set(group, set);
  }
  return map;
}

/** The union of the rights of every group the person is in. A group that is not listed gives nothing. */
export function rightsForGroups(mapping: GroupRights, groups: readonly string[]): Set<string> {
  const rights = new Set<string>();
  for (const group of groups) for (const right of mapping.get(group) ?? []) rights.add(right);
  return rights;
}

/** True when the rights grant `module:level` (admin includes everything; read is included by any level; `*` never covers canva or sissi). */
export function hasRight(rights: ReadonlySet<string>, module: string, level: Level): boolean {
  const wildcard = module !== "canva" && module !== "sissi";
  const holds = (l: Level) => rights.has(`${module}:${l}`) || (wildcard && rights.has(`*:${l}`));
  if (holds("admin")) return true;
  if (level === "read") return holds("read") || holds("write") || holds("operate");
  return holds(level);
}

/** The rights of one module as a sorted list of `module:level`, with what they imply spelled out (for the session endpoint). */
export function effectiveRights(rights: ReadonlySet<string>, module: string): string[] {
  return LEVELS.filter((level) => hasRight(rights, module, level)).map((level) => `${module}:${level}`);
}
