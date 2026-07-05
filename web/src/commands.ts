// Curated command schema for the pro console. Deliberately hand-maintained:
// these are the ~20 commands a family admin actually uses, each with typed,
// validated, autocompletable arguments. (Raw commands still possible via "say
// anything" fallback — the API validates length/newlines server-side.)

export type ArgType =
  | { kind: "player" }                    // suggests online players; free text allowed
  | { kind: "item" }                      // suggests from /items/index.json with icons
  | { kind: "warp" }                      // suggests saved warps
  | { kind: "int"; min?: number; max?: number }
  | { kind: "enum"; options: string[] }
  | { kind: "text" };                     // free text, consumes the rest

export interface CmdArg { name: string; type: ArgType; optional?: boolean }
export interface CmdSpec { name: string; desc: string; danger?: boolean; args: CmdArg[] }

const P = (name = "player"): CmdArg => ({ name, type: { kind: "player" } });
const E = (name: string, options: string[]): CmdArg => ({ name, type: { kind: "enum", options } });

export const COMMANDS: CmdSpec[] = [
  { name: "say", desc: "Announce to everyone in-game", args: [{ name: "message", type: { kind: "text" } }] },
  { name: "tell", desc: "Private message a player", args: [P(), { name: "message", type: { kind: "text" } }] },
  { name: "give", desc: "Give items to a player", args: [P(), { name: "item", type: { kind: "item" } }, { name: "count", type: { kind: "int", min: 1, max: 64 }, optional: true }] },
  { name: "tp", desc: "Teleport a player to another player", args: [P("who"), P("to")] },
  { name: "gamemode", desc: "Change a player's mode", args: [E("mode", ["survival", "creative", "adventure", "spectator"]), P()] },
  { name: "time set", desc: "Set time of day", args: [E("time", ["day", "noon", "night", "midnight"])] },
  { name: "weather", desc: "Set the weather", args: [E("type", ["clear", "rain", "thunder"]), { name: "seconds", type: { kind: "int", min: 1, max: 86400 }, optional: true }] },
  { name: "difficulty", desc: "Set world difficulty", args: [E("level", ["peaceful", "easy", "normal", "hard"])] },
  {
    name: "gamerule", desc: "Change a world rule", args: [
      E("rule", ["keepInventory", "doDaylightCycle", "doWeatherCycle", "mobGriefing", "doMobSpawning", "fallDamage", "pvp", "playersSleepingPercentage"]),
      { name: "value", type: { kind: "text" } }],
  },
  {
    name: "effect give", desc: "Give a potion effect", args: [P(),
      E("effect", ["speed", "slowness", "strength", "regeneration", "fire_resistance", "water_breathing", "night_vision", "invisibility", "jump_boost", "glowing", "levitation"]),
      { name: "seconds", type: { kind: "int", min: 1, max: 3600 }, optional: true },
      { name: "level", type: { kind: "int", min: 0, max: 9 }, optional: true }],
  },
  { name: "enchant", desc: "Enchant held item", args: [P(), E("enchantment", ["sharpness", "efficiency", "unbreaking", "fortune", "silk_touch", "looting", "protection", "feather_falling", "mending", "infinity"]), { name: "level", type: { kind: "int", min: 1, max: 5 }, optional: true }] },
  { name: "xp add", desc: "Give experience", args: [P(), { name: "amount", type: { kind: "int", min: 1, max: 10000 } }, E("unit", ["levels", "points"])] },
  { name: "summon", desc: "Spawn a friendly mob at spawn", args: [E("mob", ["cat", "dog", "wolf", "horse", "pig", "sheep", "cow", "chicken", "rabbit", "fox", "panda", "parrot", "axolotl", "allay", "camel", "sniffer"])] },
  { name: "locate structure", desc: "Find the nearest structure", args: [E("structure", ["minecraft:village_plains", "minecraft:ruined_portal", "minecraft:stronghold", "minecraft:mansion", "minecraft:monument", "minecraft:trial_chambers", "minecraft:ancient_city", "minecraft:shipwreck", "minecraft:desert_pyramid"])] },
  { name: "kick", desc: "Kick a player (they can rejoin)", args: [P(), { name: "reason", type: { kind: "text" }, optional: true }] },
  { name: "ban", desc: "Ban a player", danger: true, args: [P(), { name: "reason", type: { kind: "text" }, optional: true }] },
  { name: "pardon", desc: "Un-ban a player", args: [P()] },
  { name: "kill", desc: "Kill a player (they respawn)", danger: true, args: [P()] },
  { name: "clear", desc: "Empty a player's inventory", danger: true, args: [P()] },
  { name: "spawnpoint", desc: "Set a player's personal respawn point to where they stand", args: [P()] },
  { name: "list", desc: "Who's online?", args: [] },
];

export function validateArg(type: ArgType, value: string): string | null {
  if (!value) return "required";
  switch (type.kind) {
    case "int": {
      const n = Number(value);
      if (!Number.isInteger(n)) return "must be a whole number";
      if (type.min !== undefined && n < type.min) return `min ${type.min}`;
      if (type.max !== undefined && n > type.max) return `max ${type.max}`;
      return null;
    }
    case "enum":
      return type.options.includes(value) ? null : "pick one of the options";
    case "player":
      return /^[A-Za-z0-9_]{1,16}$/.test(value) ? null : "not a valid username";
    case "item":
      return /^[a-z0-9_]+(:[a-z0-9_/]+)?$/.test(value) ? null : "not a valid item id";
    default:
      return null;
  }
}
