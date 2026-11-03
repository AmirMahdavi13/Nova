const tool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  },
});

const text = (description) => ({ type: 'string', description });
const count = (description, minimum = 1, maximum = 256) => ({ type: 'integer', description, minimum, maximum });

const tools = [
  tool('get_status', 'Read Nova health, hunger, position, inventory, and nearby entities.'),
  tool('get_current_task', 'Read the current action and recent action results.'),
  tool('look_at_player', 'Turn toward the player who sent the request.'),
  tool('come_to_player', 'Navigate to the player who sent the request and stop nearby.'),
  tool('follow_player', 'Follow the player until stopped.'),
  tool('stop_action', 'Stop Nova current movement, mining, or combat.'),
  tool('go_to_coordinates', 'Navigate to a location in the current world.', {
    x: { type: 'integer', description: 'World X coordinate' },
    y: { type: 'integer', description: 'World Y coordinate' },
    z: { type: 'integer', description: 'World Z coordinate' },
  }, ['x', 'y', 'z']),
  tool('mine_blocks', 'Mine nearby blocks of a named Minecraft block, up to 256.', {
    block: text('Minecraft block name such as stone or oak_log'),
    count: count('Number of blocks to mine'),
  }, ['block']),
  tool('gather_blocks', 'Search within 80 blocks and mine blocks of a named type, up to 256.', {
    block: text('Minecraft block name such as oak_log'),
    count: count('Number of blocks to gather'),
  }, ['block']),
  tool('collect_drops', 'Collect nearby dropped items.', {
    all: { type: 'boolean', description: 'Collect multiple nearby item stacks' },
  }),
  tool('place_block', 'Place one block from Nova inventory against the block the player is looking at.', {
    block: text('Minecraft block/item name'),
  }, ['block']),
  tool('inspect_container', 'Read a supported container the player is looking at without moving its items.'),
  tool('take_from_container', 'Take items from the container the player is looking at.', {
    item: text('Item name'), count: count('Number of items', 1, 64),
  }, ['item']),
  tool('store_in_container', 'Store items from Nova inventory in the container the player is looking at.', {
    item: text('Item name'), count: count('Number of items', 1, 64),
  }, ['item']),
  tool('equip_item', 'Equip a named item from inventory in hand.', { item: text('Item name') }, ['item']),
  tool('craft_item', 'Complete a crafting goal. For wooden tools, gather nearby wood logs if necessary, craft planks and sticks, make and place a crafting table, then craft the requested tool. For other items, craft from current inventory materials.', {
    item: text('Item name'), count: count('Number of output items'),
  }, ['item']),
  tool('eat_food', 'Eat safe food until full, optionally using only a named food.', { item: text('Optional food name') }),
  tool('equip_best_armor', 'Equip the best available armor.'),
  tool('heal', 'Use a golden apple to recover health if Nova is injured.'),
  tool('fight', 'Fight the nearest visible hostile mob, optionally of a specified type.', { mob: text('Optional hostile mob name') }),
  tool('attack_mob', 'Attack a specifically requested visible living mob, including passive animals such as sheep, cows, pigs, or chickens. Use only when the player explicitly requests attacking that mob.', {
    mob: text('Exact Minecraft mob name, such as sheep'),
  }, ['mob']),
  tool('shoot', 'Shoot the nearest visible hostile with a bow and arrow.', { mob: text('Optional hostile mob name') }),
  tool('retreat', 'Move away from the nearest visible hostile mob.'),
  tool('sleep', 'Walk to a nearby bed and sleep when allowed.'),
  tool('wake', 'Get out of bed.'),
  tool('interact', 'Activate the button, lever, or pressure plate the player is looking at.'),
  tool('ride', 'Mount the nearest existing boat or minecart.'),
  tool('dismount', 'Dismount a boat or minecart when there is room.'),
];

function commandForTool(name, args = {}) {
  const block = String(args.block || '').toLowerCase();
  const item = String(args.item || '').toLowerCase();
  const countValue = Number.isInteger(args.count) ? ` ${args.count}` : '';
  const mob = String(args.mob || '').toLowerCase();
  const commands = {
    get_status: 'status', get_current_task: 'task', look_at_player: 'look',
    come_to_player: 'come', follow_player: 'follow', stop_action: 'stop',
    go_to_coordinates: `go ${args.x} ${args.y} ${args.z}`,
    mine_blocks: `mine ${block}${countValue}`, gather_blocks: `gather ${block}${countValue}`,
    collect_drops: args.all ? 'collect all' : 'collect', place_block: `place ${block}`,
    inspect_container: 'open', take_from_container: `take ${item}${countValue}`,
    store_in_container: `store ${item}${countValue}`, equip_item: `equip ${item}`,
    craft_item: `craft ${item}${countValue}`, eat_food: args.item ? `eat ${item}` : 'eat',
    equip_best_armor: 'armor', heal: 'heal', fight: mob ? `fight ${mob}` : 'fight',
    attack_mob: `attack ${mob}`,
    shoot: mob ? `shoot ${mob}` : 'shoot', retreat: 'retreat', sleep: 'sleep', wake: 'wake',
    interact: 'interact', ride: 'ride', dismount: 'dismount',
  };
  return commands[name] || null;
}

const readOnlyTools = new Set(['get_status', 'get_current_task']);

module.exports = { tools, commandForTool, readOnlyTools };
