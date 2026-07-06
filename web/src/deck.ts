// Data + heuristics for the Deck (visual console). No hand-maintained item DB:
// categories are inferred from item ids, so new Minecraft versions just work.

export const CATEGORIES = ["favorites", "tools", "combat", "food", "blocks", "transport", "magic", "mobs", "misc"] as const;
export type Category = (typeof CATEGORIES)[number];

const RULES: [Category, RegExp][] = [
  ["mobs", /_spawn_egg$/],
  ["tools", /(_pickaxe|_axe|_shovel|_hoe|shears|flint_and_steel|fishing_rod|compass|clock|spyglass|brush|lead|name_tag|bucket)$/],
  ["combat", /(_sword|bow$|crossbow|arrow|shield|_helmet|_chestplate|_leggings|_boots|trident|mace|totem)/],
  ["food", /(apple|bread|cooked_|beef|porkchop|mutton|rabbit$|cod$|salmon$|carrot|potato$|beetroot|melon_slice|cookie|cake|pie|stew|soup|berries|honey_bottle|milk_bucket|chicken$)/],
  ["transport", /(boat|raft|minecart|rail$|saddle|elytra|_horse_armor)/],
  ["magic", /(potion|enchanted|ender_|experience_bottle|amethyst|beacon|conduit|_shard|blaze_|ghast_tear|nether_star|book$)/],
  ["blocks", /(_planks|_log|_wood|stone$|_stone|cobble|_bricks?|dirt|sand$|sandstone|glass|wool$|concrete|terracotta|_slab|_stairs|_wall|_fence|_ore|deepslate|obsidian|_block|torch|lantern|_door|_trapdoor|bed$|chest$|barrel|shelf|glowstone)/],
];

export function categorize(id: string): Category {
  for (const [cat, re] of RULES) if (re.test(id)) return cat;
  return "misc";
}

export const FAVORITES = [
  "diamond", "emerald", "golden_apple", "enchanted_golden_apple", "cake", "cookie",
  "diamond_sword", "diamond_pickaxe", "bow", "arrow", "shield", "elytra", "saddle",
  "ender_pearl", "torch", "oak_boat", "minecart", "firework_rocket", "name_tag", "totem_of_undying",
];

export const EFFECTS = [
  { id: "speed", label: "💨 speed" }, { id: "jump_boost", label: "🦘 jump" },
  { id: "strength", label: "💪 strength" }, { id: "regeneration", label: "❤️ regen" },
  { id: "resistance", label: "🛡 resist" }, { id: "fire_resistance", label: "🔥 fireproof" },
  { id: "water_breathing", label: "🐟 gills" }, { id: "night_vision", label: "👁 night eyes" },
  { id: "invisibility", label: "👻 invisible" }, { id: "glowing", label: "✨ glow" },
  { id: "slow_falling", label: "🪂 feather fall" }, { id: "haste", label: "⛏ haste" },
];

export const MOBS = ["cat", "wolf", "horse", "donkey", "camel", "pig", "sheep", "cow", "mooshroom",
  "chicken", "rabbit", "fox", "panda", "parrot", "axolotl", "allay", "goat", "frog", "turtle", "llama", "sniffer"];

export const GAMEMODES = ["survival", "creative", "adventure", "spectator"] as const;
