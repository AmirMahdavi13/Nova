require('dotenv').config();

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { BlockFace } = require('prismarine-world').iterators;
const { startPerception } = require('./perception');
const { ActionManager } = require('./actionManager');
const { LlmClient } = require('./llm');
const { commandForTool, readOnlyTools } = require('./aiTools');

const config = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || 'Nova',
  version: process.env.MC_VERSION || '1.21.8',
};

const bot = mineflayer.createBot({
  ...config,
  auth: 'offline',
});
bot.loadPlugin(pathfinder);
const actionManager = new ActionManager();
const llm = new LlmClient();

const commandPrefix = '!nova';
const dimensionNames = {
  overworld: 'Overworld',
  nether: 'Nether',
  the_end: 'The End',
};
const placementFaces = {
  [BlockFace.BOTTOM]: new Vec3(0, -1, 0),
  [BlockFace.TOP]: new Vec3(0, 1, 0),
  [BlockFace.NORTH]: new Vec3(0, 0, -1),
  [BlockFace.SOUTH]: new Vec3(0, 0, 1),
  [BlockFace.WEST]: new Vec3(-1, 0, 0),
  [BlockFace.EAST]: new Vec3(1, 0, 0),
};
let movementRequestId = 0;
let miningRequestId = 0;
let perception = null;
let combatShieldActive = false;
let bowUseActive = false;
const autoOpenedDoors = new Map();
let doorMaintenanceTimer = null;
let doorMaintenanceBusy = false;
let pendingApproval = null;

function trackActionChatMessages() {
  if (typeof bot.chat !== 'function' || bot.chat.novaTracked) return;
  const originalBotChat = bot.chat.bind(bot);
  const trackedBotChat = (message) => {
    actionManager.noteMessage(message);
    return originalBotChat(message);
  };
  trackedBotChat.novaTracked = true;
  bot.chat = trackedBotChat;
}

async function runAction(name, username, execute, { persistent = false } = {}) {
  const started = actionManager.start(name, username, { persistent });
  if (!started.accepted) {
    bot.chat(`I am already working on ${started.active.name}. Use !nova task or !nova stop first.`);
    return { accepted: false, reason: 'busy', active: started.active };
  }
  pendingApproval = null;

  try {
    await execute();
    if (persistent) {
      actionManager.update('Following until stopped');
      return { accepted: true, status: 'running', action: actionManager.snapshot() };
    }
    const result = actionManager.snapshot();
    if (!result || result.id !== started.id) {
      return { accepted: true, status: 'stopped', action: actionManager.recent()[0] || null };
    }
    const lastMessage = result.lastMessage || '';
    const outcome = /\b(of \d+|I have \d+ .* you asked|no more reachable|no more .* found|before I got stuck|so far)\b/i.test(lastMessage)
      ? 'partial'
      : /\b(could not|couldn't|cannot|can't|don't have|do not have|I do not know|I need|not edible|lost sight|no reachable|outside the world bounds|got stuck|stopped before|is more than .* away|is not nearby|there may not be room|container is empty)\b/i.test(lastMessage)
        ? 'needs_attention'
        : 'completed';
    const status = outcome === 'completed' ? 'completed' : outcome;
    actionManager.finish(started.id, status, lastMessage || 'Finished', outcome);
    return { accepted: true, status, action: actionManager.recent()[0] || result };
  } catch (error) {
    actionManager.finish(started.id, 'failed', error.message);
    console.error(`Nova action failed (${name}):`, error.message);
    bot.chat(`I could not finish ${name}: ${error.message}`);
    return { accepted: true, status: 'failed', error: error.message };
  }
}

function stopCurrentAction() {
  movementRequestId += 1;
  miningRequestId += 1;
  setPathTraversal();
  if (combatShieldActive || bowUseActive) {
    bot.deactivateItem();
    combatShieldActive = false;
    bowUseActive = false;
  }
  if (bot.targetDigBlock) bot.stopDigging();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  const active = actionManager.snapshot();
  if (active) actionManager.finish(active.id, 'stopped');
}

function worldContext() {
  const snapshot = perception?.getSnapshot();
  const position = bot.entity?.position;
  const inventory = new Map();
  for (const item of bot.inventory.items()) inventory.set(item.name, (inventory.get(item.name) || 0) + item.count);
  return {
    connected: Boolean(position),
    dimension: bot.game?.dimension || 'unknown',
    position: position ? { x: Number(position.x.toFixed(1)), y: Number(position.y.toFixed(1)), z: Number(position.z.toFixed(1)) } : null,
    health: Number.isFinite(bot.health) ? bot.health : null,
    hunger: Number.isFinite(bot.food) ? bot.food : null,
    heldItem: bot.heldItem?.name || null,
    inventory: [...inventory.entries()].slice(0, 40).map(([name, count]) => ({ name, count })),
    nearbyPlayers: snapshot?.nearbyPlayers || [],
    nearbyHostiles: snapshot?.nearbyHostiles || [],
    action: actionManager.snapshot(),
  };
}

function approvedToolAction(name, args, username) {
  const block = String(args.block || '').toLowerCase();
  const item = String(args.item || '').toLowerCase();
  const mob = String(args.mob || '').toLowerCase();
  const count = Number.isInteger(args.count) ? args.count : 1;
  const actions = {
    look_at_player: () => runAction('look', username, () => lookAtPlayer(username)),
    come_to_player: () => runAction('come', username, () => comeToPlayer(username)),
    follow_player: () => runAction('follow', username, () => followPlayer(username), { persistent: true }),
    go_to_coordinates: () => runAction('go', username, () => goToCoordinates(username, args.x, args.y, args.z)),
    mine_blocks: () => runAction('mine', username, () => mineNearbyBlocks(username, block, count)),
    gather_blocks: () => runAction('gather', username, () => gatherBlocks(username, block, count)),
    collect_drops: () => runAction('collect', username, () => collectNearbyDrops(username, Boolean(args.all))),
    place_block: () => runAction('place', username, () => placeBlockFromInventory(username, block)),
    inspect_container: () => runAction('open container', username, () => inspectContainer(username)),
    take_from_container: () => runAction('take items', username, () => takeFromContainer(username, item, count)),
    store_in_container: () => runAction('store items', username, () => storeInContainer(username, item, count)),
    equip_item: () => runAction('equip item', username, () => equipItem(username, item)),
    craft_item: () => runAction('craft', username, () => craftItem(username, item, count)),
    eat_food: () => runAction('eat', username, () => eatFood(username, item || undefined)),
    equip_best_armor: () => runAction('equip armor', username, () => equipBestArmor(username)),
    heal: () => runAction('heal', username, () => healWithGoldenApple(username)),
    fight: () => runAction('fight', username, () => defendAgainstHostile(username, mob || undefined)),
    attack_mob: () => runAction(`attack ${mob}`, username, () => defendAgainstHostile(username, mob, { allowPassive: true })),
    shoot: () => runAction('shoot', username, () => shootHostile(username, mob || undefined)),
    retreat: () => runAction('retreat', username, () => retreatFromHostile(username)),
    sleep: () => runAction('sleep', username, () => sleepInNearbyBed(username)),
    wake: () => runAction('wake', username, () => wakeFromBed(username)),
    interact: () => runAction('interact', username, () => interactWithAimedBlock(username)),
    ride: () => runAction('ride', username, () => mountNearestVehicle(username)),
    dismount: () => runAction('dismount', username, () => dismountVehicle(username)),
  };
  return actions[name]?.() || Promise.resolve({ accepted: false, reason: 'unknown_tool' });
}

async function askLlm(username, prompt) {
  if (pendingApproval) {
    bot.chat(`Please !nova approve or !nova reject the pending plan for ${pendingApproval.username} first.`);
    return;
  }
  if (!llm.isConfigured()) {
    bot.chat('My language model is not configured yet. Set LLM_ENABLED=true and LLM_MODEL in .env.');
    return;
  }
  try {
    const answer = await llm.respond({
      system: 'You are Nova, a Minecraft teammate. The player may write in Persian or English, but always reply in English. Use the available tools when useful. For crafting goals, use craft_item; Nova can autonomously gather nearby wood and make the intermediate parts and crafting table for wooden tools. For an explicitly requested passive animal such as a sheep, use attack_mob; use fight only for hostile mobs. Never claim an action succeeded unless its tool result confirms it. Any action-changing tool requires player approval; explain the proposed goal and ask the player to type !nova approve. The only live game information you know is the supplied context and tool results. Keep chat replies concise.',
      user: prompt,
      context: worldContext(),
      executeTool: async (name, args) => {
        if (name === 'get_status') return { status: 'read_only', context: worldContext() };
        if (name === 'get_current_task') return { status: 'read_only', current: actionManager.snapshot(), recent: actionManager.recent().slice(0, 5) };
        if (name === 'stop_action') {
          stopCurrentAction();
          return { status: 'stopped', action: actionManager.recent()[0] || null };
        }
        if (readOnlyTools.has(name)) return { error: 'Unsupported read-only tool.' };
        const command = commandForTool(name, args);
        if (!command) return { error: 'Unknown action tool.' };
        if (name === 'go_to_coordinates') {
          const minY = bot.game.minY;
          const maxY = minY + bot.game.height - 1;
          if ([args.x, args.y, args.z].some((value) => !Number.isInteger(value))
            || Math.abs(args.x) > 29_999_984 || Math.abs(args.z) > 29_999_984 || args.y < minY || args.y > maxY) {
            return { error: 'Those coordinates are outside the world bounds.' };
          }
        }
        if (actionManager.snapshot()) return { error: `Nova is currently busy with ${actionManager.snapshot().name}.` };
        if (!pendingApproval) pendingApproval = { username, request: prompt, actions: [], createdAt: Date.now() };
        if (pendingApproval.username !== username) return { error: 'Another player already has a plan waiting for approval.' };
        pendingApproval.actions.push({ name, args, command });
        return { requiresApproval: true, status: 'awaiting_player_approval', action: command };
      },
    });
    if (pendingApproval?.username === username) {
      const plan = pendingApproval.actions.map((action) => action.command).join('; ');
      const suffix = `Plan: ${plan}. Reply !nova approve or !nova reject.`;
      bot.chat(`${answer.slice(0, Math.max(0, 238 - suffix.length))} ${suffix}`.slice(0, 240));
    } else {
      bot.chat(answer.slice(0, 240));
    }
  } catch (error) {
    console.error('LLM request failed:', error.message);
    bot.chat(`I could not reach my language model: ${error.message.slice(0, 120)}`);
  }
}

async function reportApprovedResults(proposal, results) {
  const evidence = results.map(({ command, result }) => ({
    command,
    status: result?.status || 'unknown',
    outcome: result?.action?.outcome || null,
    progress: result?.action?.progress || result?.action?.lastMessage || null,
    error: result?.error || result?.reason || null,
  }));
  let response;
  try {
    const message = await llm.complete([
      {
        role: 'system',
        content: 'You are Nova, a Minecraft teammate. Reply in English, briefly. Report what the action results actually show. Only describe an action as completed when its status is completed; explain failures and obstacles from the evidence, and suggest one practical next step when useful. Do not claim unverified effects or invent details.',
      },
      {
        role: 'user',
        content: JSON.stringify({ playerRequest: proposal.request, actionResults: evidence }),
      },
    ]);
    response = message.content?.trim();
  } catch (error) {
    console.error('Could not summarize Nova action results:', error.message);
  }

  if (!response) {
    response = evidence.map(({ command, status, progress, error }) =>
      `${command}: ${status}${progress ? ` — ${progress}` : ''}${error ? ` (${error})` : ''}`,
    ).join('; ');
  }
  bot.chat(response.slice(0, 240));
}

function setPathTraversal({ canDig = true, canTower = true } = {}) {
  const movements = new Movements(bot);
  movements.canDig = canDig;
  const feetPosition = bot.entity?.position?.floored();
  const overhead = feetPosition && bot.blockAt(feetPosition.offset(0, 2, 0));
  movements.allow1by1towers = canTower && overhead?.boundingBox === 'empty';
  movements.dontMineUnderFallingBlock = true;
  movements.dontCreateFlow = true;
  movements.canOpenDoors = true;
  // Prefer using doors or finding a walkable route over cutting a new path.
  // Digging remains available when there is no practical alternative.
  movements.digCost = 18;
  movements.placeCost = 2.5;

  const scaffoldNames = [
    'dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'netherrack',
    'tuff', 'andesite', 'diorite', 'granite', 'blackstone', 'basalt',
  ];
  const scaffoldIds = scaffoldNames
    .map((name) => bot.registry.itemsByName[name]?.id)
    .filter((id) => id !== undefined);
  if (scaffoldIds.length > 0) movements.scafoldingBlocks = scaffoldIds;

  if (canDig) {
    for (const block of bot.registry.blocksArray) {
      if (/(?:_ore|ancient_debris|spawner|_shulker_box|_chest$|^chest$|^barrel$|^hopper$|dispenser$|dropper$|furnace$|smoker$|crafting_table$|anvil$|brewing_stand$|enchanting_table$|loom$|smithing_table$|stonecutter$|cartography_table$|fletching_table$|grindstone$|lectern$|composter$|beehive$|bee_nest$|bell$|_bed$|^bed$|^(?:red_)?sand$|^gravel$|concrete_powder$|_door$|_trapdoor$|_gate$|_button$|^lever$|_pressure_plate$)/.test(block.name)) {
        movements.blocksCantBreak.add(block.id);
      }
    }
  }

  const safeToBreak = movements.safeToBreak.bind(movements);
  movements.safeToBreak = (block) => {
    const feetY = bot.entity?.position ? Math.floor(bot.entity.position.y) : null;
    if (feetY !== null && block.position.y > feetY) return false;
    return safeToBreak(block);
  };

  bot.pathfinder.setMovements(movements);
}

function isPathDoor(name) {
  return /(?:_door|_trapdoor|_gate)$/.test(name);
}

function trackDoorsOnPath(results) {
  for (const point of results.path || []) {
    for (const action of point.toPlace || []) {
      if (!action.useOne) continue;
      const actionBlock = bot.blockAt(new Vec3(action.x, action.y, action.z));
      if (!actionBlock || !isPathDoor(actionBlock.name)) continue;
      const properties = actionBlock.getProperties();
      if (properties.open !== false) continue;

      const position = properties.half === 'upper' ? actionBlock.position.offset(0, -1, 0) : actionBlock.position;
      const key = `${position.x},${position.y},${position.z}`;
      if (!autoOpenedDoors.has(key)) {
        autoOpenedDoors.set(key, { position, opened: false, passed: false, closing: false });
      }
    }
  }

  if (autoOpenedDoors.size > 0 && !doorMaintenanceTimer) {
    doorMaintenanceTimer = setInterval(() => void maintainAutoOpenedDoors(), 200);
    doorMaintenanceTimer.unref?.();
  }
}

async function maintainAutoOpenedDoors() {
  if (doorMaintenanceBusy || !bot.entity?.position) return;
  doorMaintenanceBusy = true;
  try {
    for (const [key, door] of autoOpenedDoors) {
      const block = bot.blockAt(door.position);
      if (!block || !isPathDoor(block.name)) {
        autoOpenedDoors.delete(key);
        continue;
      }

      if (block.getProperties().open === true) door.opened = true;
      else if (door.opened) {
        autoOpenedDoors.delete(key);
        continue;
      }
      if (!door.opened) continue;

      const center = door.position.offset(0.5, 0.5, 0.5);
      const distance = bot.entity.position.distanceTo(center);
      if (distance <= 1.7) door.passed = true;
      if (!door.passed || distance < 2.2 || distance > 4.2 || door.closing) continue;

      const doorwayOccupied = Object.values(bot.entities).some((entity) => entity.id !== bot.entity.id
        && entity.position
        && entity.name !== 'item'
        && entity.name !== 'item_stack'
        && entity.name !== 'experience_orb'
        && entity.position.distanceTo(center) < 1.25);
      if (doorwayOccupied) continue;

      door.closing = true;
      await bot.activateBlock(block);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const updatedBlock = bot.blockAt(door.position);
      if (updatedBlock?.getProperties().open === false) autoOpenedDoors.delete(key);
      else door.closing = false;
    }
  } catch (error) {
    console.error('Could not maintain automatic doors:', error.message);
  } finally {
    doorMaintenanceBusy = false;
    if (autoOpenedDoors.size === 0 && doorMaintenanceTimer) {
      clearInterval(doorMaintenanceTimer);
      doorMaintenanceTimer = null;
    }
  }
}

function sendStatus() {
  if (!bot.entity || !bot.entity.position) {
    bot.chat('I do not have my game status yet. Please try again in a moment.');
    return;
  }

  const snapshot = perception?.getSnapshot();
  const position = snapshot?.position || bot.entity.position;
  const dimensionKey = snapshot?.dimension || bot.game.dimension;
  const dimension = dimensionNames[dimensionKey] || dimensionKey || 'Unknown';
  const heldItem = bot.heldItem ? `${bot.heldItem.count} ${bot.heldItem.name}` : 'empty-handed';
  const inventoryCounts = new Map();

  for (const item of bot.inventory.items()) {
    inventoryCounts.set(item.name, (inventoryCounts.get(item.name) || 0) + item.count);
  }

  const inventorySummary = [...inventoryCounts.entries()]
    .slice(0, 6)
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ') || 'empty';

  const nearbyEntities = Object.values(bot.entities)
    .filter((entity) => entity.id !== bot.entity.id
      && (entity.type === 'player' || ['hostile', 'passive', 'animal', 'mob'].includes(entity.type)))
    .map((entity) => ({
      name: entity.type === 'player' ? entity.username : (entity.displayName || entity.name || 'entity'),
      distance: entity.position ? position.distanceTo(entity.position) : Infinity,
    }))
    .filter((entity) => entity.distance <= 16)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4)
    .map((entity) => `${entity.name} (${Math.round(entity.distance)} blocks)`)
    .join(', ') || 'nothing within 16 blocks';

  const health = Number.isFinite(bot.health) ? `${bot.health}/20` : 'unknown';
  const food = Number.isFinite(bot.food) ? `${bot.food}/20` : 'unknown';

  bot.chat(`Status: health ${health}, hunger ${food} | ${dimension} | ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`);
  setTimeout(() => bot.chat(`Holding: ${heldItem} | Inventory: ${inventorySummary}`), 700);
  setTimeout(() => bot.chat(`Nearby: ${nearbyEntities}`), 1400);
}

async function lookAtPlayer(username) {
  const player = bot.players[username]?.entity
    || Object.values(bot.entities).find((entity) => entity.type === 'player' && entity.username === username);

  if (!player?.position) {
    bot.chat(`I cannot see you right now, ${username}.`);
    return;
  }

  try {
    const eyeHeight = Number.isFinite(player.height) ? player.height * 0.9 : 1.5;
    await bot.lookAt(player.position.offset(0, eyeHeight, 0), true);
    bot.chat(`Looking at you, ${username}.`);
  } catch (error) {
    console.error('Could not look at player:', error.message);
    bot.chat(`I could not turn to look at you, ${username}.`);
  }
}

function findPlayer(username) {
  return bot.players[username]?.entity
    || Object.values(bot.entities).find((entity) => entity.type === 'player' && entity.username === username);
}

function blockAtAim(entity, maxDistance = 5) {
  if (!entity?.position || !Number.isFinite(entity.yaw) || !Number.isFinite(entity.pitch)) return null;

  const direction = new Vec3(
    -Math.sin(entity.yaw) * Math.cos(entity.pitch),
    Math.sin(entity.pitch),
    -Math.cos(entity.yaw) * Math.cos(entity.pitch),
  ).normalize();

  return bot.world.raycast(
    entity.position.offset(0, entity.eyeHeight || entity.height * 0.9 || 1.62, 0),
    direction,
    maxDistance,
  );
}

function containerAtPlayerAim(username) {
  const block = blockAtAim(findPlayer(username), 10);
  const supportedContainers = /^(chest|trapped_chest|barrel|ender_chest|hopper|dispenser|dropper|[a-z]+_shulker_box)$/;
  return block && supportedContainers.test(block.name) ? block : null;
}

async function interactWithAimedBlock(username) {
  const target = blockAtAim(findPlayer(username), 10);
  const interactive = /(?:_button|^lever$|_pressure_plate$)/;
  if (!target || !interactive.test(target.name)) {
    bot.chat('Look at a button, lever, or pressure plate within 10 blocks. Doors and gates are handled automatically while I move.');
    return;
  }

  const requestId = ++movementRequestId;
  miningRequestId += 1;
  setPathTraversal();
  if (bot.targetDigBlock) bot.stopDigging();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();

  try {
    if (target.name.endsWith('_pressure_plate')) {
      bot.chat('Stepping onto the pressure plate.');
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y + 1, target.position.z, 0));
      if (requestId === movementRequestId) bot.chat('I stepped onto the pressure plate.');
      return;
    }

    if (bot.entity.position.distanceTo(target.position.offset(0.5, 0.5, 0.5)) > 4.5) {
      bot.chat(`Moving closer to the ${target.name.replaceAll('_', ' ')}.`);
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 3));
      if (requestId !== movementRequestId) return;
    }

    const block = bot.blockAt(target.position);
    if (!block || !interactive.test(block.name)) {
      bot.chat('I lost sight of that interactive block.');
      return;
    }
    await bot.activateBlock(block);
    if (requestId === movementRequestId) bot.chat(`I activated the ${block.name.replaceAll('_', ' ')}, ${username}.`);
  } catch (error) {
    if (requestId === movementRequestId) {
      console.error('Could not interact with block:', error.message);
      bot.chat(`I could not activate the ${target.name.replaceAll('_', ' ')}.`);
    }
  }
}

function isRideableEntity(entity) {
  return /(?:boat|minecart)/i.test(entity.name || entity.displayName || '');
}

async function mountNearestVehicle(username) {
  if (bot.vehicle) {
    bot.chat(`I am already riding a vehicle, ${username}.`);
    return;
  }
  const vehicle = Object.values(bot.entities)
    .filter((entity) => isRideableEntity(entity) && entity.position
      && bot.entity.position.distanceTo(entity.position) <= 32)
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
  if (!vehicle) {
    bot.chat('I cannot find a boat or minecart within 32 blocks.');
    return;
  }

  const requestId = ++movementRequestId;
  miningRequestId += 1;
  setPathTraversal();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  try {
    if (bot.entity.position.distanceTo(vehicle.position) > 3) {
      bot.chat(`Moving to the ${vehicle.name.replaceAll('_', ' ')}.`);
      await bot.pathfinder.goto(new goals.GoalNear(vehicle.position.x, vehicle.position.y, vehicle.position.z, 2));
      if (requestId !== movementRequestId) return;
    }
    if (!bot.entities[vehicle.id]) {
      bot.chat('The vehicle is no longer nearby.');
      return;
    }
    const mountConfirmed = new Promise((resolve) => bot.once('mount', resolve));
    bot.mount(vehicle);
    await Promise.race([mountConfirmed, new Promise((resolve) => setTimeout(resolve, 1_200))]);
    if (requestId !== movementRequestId) return;
    bot.chat(bot.vehicle
      ? `I mounted the ${vehicle.name.replaceAll('_', ' ')}, ${username}.`
      : `I could not mount the ${vehicle.name.replaceAll('_', ' ')}.`);
  } catch (error) {
    if (requestId === movementRequestId) {
      console.error('Could not mount vehicle:', error.message);
      bot.chat('I could not reach or mount that vehicle.');
    }
  }
}

async function dismountVehicle(username) {
  if (!bot.vehicle) {
    bot.chat(`I am not riding a vehicle, ${username}.`);
    return;
  }
  try {
    movementRequestId += 1;
    miningRequestId += 1;
    bot.pathfinder.setGoal(null);
    const dismountConfirmed = new Promise((resolve) => bot.once('dismount', resolve));
    bot.dismount();
    await Promise.race([dismountConfirmed, new Promise((resolve) => setTimeout(resolve, 1_200))]);
    bot.chat(bot.vehicle ? 'I could not dismount here; there may not be room.' : `I dismounted, ${username}.`);
  } catch (error) {
    console.error('Could not dismount vehicle:', error.message);
    bot.chat('I could not dismount from the vehicle.');
  }
}

async function openTargetContainer(username) {
  const target = containerAtPlayerAim(username);
  if (!target) {
    bot.chat('I cannot see a supported container in your crosshair within 10 blocks.');
    return null;
  }

  const requestId = ++movementRequestId;
  miningRequestId += 1;
  if (combatShieldActive || bowUseActive) {
    bot.deactivateItem();
    combatShieldActive = false;
    bowUseActive = false;
  }
  setPathTraversal();
  if (bot.targetDigBlock) bot.stopDigging();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();

  try {
    const targetDistance = bot.entity.position.distanceTo(target.position.offset(0.5, 0.5, 0.5));
    if (targetDistance > 4.5) {
      bot.chat('Moving closer to the container.');
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 3));
      if (requestId !== movementRequestId) return null;
    }

    const block = bot.blockAt(target.position);
    if (!block) {
      bot.chat('I lost sight of that container.');
      return null;
    }

    return await bot.openContainer(block);
  } catch (error) {
    if (requestId === movementRequestId) {
      console.error('Could not open target container:', error.message);
      bot.chat(`I could not reach or open that container, ${username}.`);
    }
    return null;
  }
}

function followPlayer(username) {
  const player = findPlayer(username);
  if (!player?.position) {
    bot.chat(`I cannot see you right now, ${username}.`);
    return;
  }

  movementRequestId += 1;
  setPathTraversal({ canDig: true, canTower: true });
  bot.pathfinder.setGoal(new goals.GoalFollow(player, 2), true);
  bot.chat(`I will follow you and use safe blocks or scaffolding to handle height changes, ${username}.`);
}

async function comeToPlayer(username) {
  const player = findPlayer(username);
  if (!player?.position) {
    bot.chat(`I cannot see you right now, ${username}.`);
    return;
  }

  const requestId = ++movementRequestId;
  setPathTraversal({ canDig: true, canTower: true });
  const { x, y, z } = player.position;
  bot.chat(`Coming to you, ${username}.`);

  try {
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
    if (requestId === movementRequestId) bot.chat(`I'm here, ${username}.`);
  } catch (error) {
    if (requestId === movementRequestId) {
      console.error('Could not reach player:', error.message);
      bot.chat(`I could not reach you, ${username}.`);
    }
  } finally {
    if (requestId === movementRequestId) setPathTraversal();
  }
}

async function goToCoordinates(username, x, y, z) {
  const requestId = ++movementRequestId;
  setPathTraversal();
  bot.chat(`Moving to ${x}, ${y}, ${z}, ${username}.`);

  try {
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
    if (requestId === movementRequestId) bot.chat(`I reached ${x}, ${y}, ${z}, ${username}.`);
  } catch (error) {
    if (requestId === movementRequestId) {
      console.error('Could not reach coordinates:', error.message);
      bot.chat(`I could not reach ${x}, ${y}, ${z}.`);
    }
  }
}

async function mineNearbyBlocks(username, requestedName, requestedCount) {
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 256) {
    bot.chat('Choose a number from 1 to 256 blocks.');
    return;
  }

  const blockName = requestedName.replace(/^minecraft:/, '');
  const blockType = bot.registry.blocksByName[blockName];

  if (!blockType) {
    bot.chat(`I do not know the block "${requestedName}".`);
    return;
  }

  const requestId = ++miningRequestId;
  const moveId = ++movementRequestId;
  setPathTraversal();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  let minedCount = 0;

  try {
    while (minedCount < requestedCount && requestId === miningRequestId && moveId === movementRequestId) {
      const positions = bot.findBlocks({ matching: blockType.id, maxDistance: 4, count: 32 });
      const block = positions
        .map((position) => bot.blockAt(position))
        .find((candidate) => candidate && bot.canDigBlock(candidate));

      if (!block) break;

      const tool = bot.pathfinder.bestHarvestTool(block);
      if (tool) await bot.equip(tool, 'hand');
      if (requestId !== miningRequestId || moveId !== movementRequestId) break;

      await bot.dig(block);
      if (requestId !== miningRequestId || moveId !== movementRequestId) break;
      minedCount += 1;
    }

    if (requestId === miningRequestId && moveId === movementRequestId) {
      if (minedCount === requestedCount) {
        bot.chat(`I mined ${minedCount} ${blockName} block${minedCount === 1 ? '' : 's'}, ${username}.`);
      } else if (minedCount > 0) {
        bot.chat(`I mined ${minedCount} of ${requestedCount} ${blockName} blocks. No more are reachable.`);
      } else {
        bot.chat(`I could not find a reachable ${blockName} within 4 blocks.`);
      }
    }
  } catch (error) {
    if (requestId === miningRequestId && moveId === movementRequestId) {
      console.error('Could not mine block:', error.message);
      bot.chat(`I mined ${minedCount} of ${requestedCount} ${blockName} blocks before I got stuck.`);
    }
  }
}

async function gatherBlocks(username, requestedName, requestedCount) {
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 256) {
    bot.chat('Choose a number from 1 to 256 blocks.');
    return;
  }

  const blockName = requestedName.replace(/^minecraft:/, '');
  const blockType = bot.registry.blocksByName[blockName];
  if (!blockType) {
    bot.chat(`I do not know the block "${requestedName}".`);
    return;
  }

  const requestId = ++miningRequestId;
  const moveId = ++movementRequestId;
  setPathTraversal();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  const attempted = new Set();
  let minedCount = 0;
  bot.chat(`Looking for ${requestedCount} ${blockName} blocks within 80 blocks.`);

  while (minedCount < requestedCount && requestId === miningRequestId && moveId === movementRequestId) {
    const positions = bot.findBlocks({ matching: blockType.id, maxDistance: 80, count: 256 });
    const candidate = positions.find((position) => {
      const key = `${position.x},${position.y},${position.z}`;
      return !attempted.has(key);
    });

    if (!candidate) break;
    const key = `${candidate.x},${candidate.y},${candidate.z}`;

    try {
      await bot.pathfinder.goto(new goals.GoalNear(candidate.x, candidate.y, candidate.z, 3));
      if (requestId !== miningRequestId || moveId !== movementRequestId) return;

      const block = bot.blockAt(candidate);
      if (!block || block.type !== blockType.id || !bot.canDigBlock(block)) {
        attempted.add(key);
        continue;
      }

      const tool = bot.pathfinder.bestHarvestTool(block);
      if (tool) await bot.equip(tool, 'hand');
      if (requestId !== miningRequestId || moveId !== movementRequestId) return;

      await bot.dig(block);
      if (requestId !== miningRequestId || moveId !== movementRequestId) return;
      minedCount += 1;

      if (minedCount % 5 === 0 && minedCount < requestedCount) {
        bot.chat(`Gather progress: ${minedCount}/${requestedCount} ${blockName} blocks.`);
      }
    } catch (error) {
      if (requestId !== miningRequestId || moveId !== movementRequestId) return;
      attempted.add(key);
      console.error(`Could not gather ${blockName} at ${key}:`, error.message);
    }
  }

  if (requestId !== miningRequestId || moveId !== movementRequestId) return;
  if (minedCount === requestedCount) {
    bot.chat(`I gathered ${minedCount} ${blockName} blocks, ${username}.`);
  } else if (minedCount > 0) {
    bot.chat(`I gathered ${minedCount} of ${requestedCount} ${blockName} blocks. No more reachable blocks were found nearby.`);
  } else {
    bot.chat(`I could not find a reachable ${blockName} within 80 blocks.`);
  }
}

async function placeBlockFromInventory(username, requestedName) {
  const blockName = requestedName.replace(/^minecraft:/, '');
  const blockType = bot.registry.blocksByName[blockName];
  const blockItem = bot.registry.itemsByName[blockName];

  if (!blockType || !blockItem) {
    bot.chat(`I do not know a placeable block called "${requestedName}".`);
    return;
  }

  const stack = bot.inventory.items().find((item) => item.type === blockItem.id);
  if (!stack) {
    bot.chat(`I do not have any ${blockName} in my inventory.`);
    return;
  }

  const referenceBlock = blockAtAim(findPlayer(username), 5);
  const faceVector = referenceBlock && placementFaces[referenceBlock.face];

  if (!referenceBlock || !faceVector) {
    bot.chat('Look at a block within 5 blocks so I know where to place it.');
    return;
  }

  movementRequestId += 1;
  miningRequestId += 1;
  if (bot.targetDigBlock) bot.stopDigging();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();

  try {
    await bot.equip(stack, 'hand');
    await bot.placeBlock(referenceBlock, faceVector);
    bot.chat(`I placed one ${blockName}, ${username}.`);
  } catch (error) {
    console.error('Could not place block:', error.message);
    bot.chat(`I could not place that ${blockName}. Make sure the target space is clear.`);
  }
}

async function inspectContainer(username) {
  let container;
  try {
    container = await openTargetContainer(username);
    if (!container) return;
    const counts = new Map();
    for (const item of container.containerItems()) {
      counts.set(item.name, (counts.get(item.name) || 0) + item.count);
    }

    const entries = [...counts.entries()];
    const summary = entries.slice(0, 8).map(([name, count]) => `${name} ×${count}`).join(', ');
    const more = entries.length > 8 ? `, and ${entries.length - 8} more types` : '';
    bot.chat(entries.length ? `Container contents: ${summary}${more}.` : 'That container is empty.');
  } catch (error) {
    console.error('Could not inspect container:', error.message);
    bot.chat(`I could not open that container, ${username}.`);
  } finally {
    if (container) container.close();
  }
}

async function takeFromContainer(username, requestedName, requestedCount) {
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 64) {
    bot.chat('Choose a number from 1 to 64 items.');
    return;
  }

  const itemName = requestedName.replace(/^minecraft:/, '');
  const itemType = bot.registry.itemsByName[itemName];
  if (!itemType) {
    bot.chat(`I do not know an item called "${requestedName}".`);
    return;
  }

  let container;
  try {
    container = await openTargetContainer(username);
    if (!container) return;
    const available = container.containerCount(itemType.id, null);
    if (available < requestedCount) {
      bot.chat(`The container has ${available} ${itemName}; you asked for ${requestedCount}.`);
      return;
    }

    await container.withdraw(itemType.id, null, requestedCount, null);
    bot.chat(`I took ${requestedCount} ${itemName} from the container, ${username}.`);
  } catch (error) {
    console.error('Could not take item from container:', error.message);
    bot.chat(`I could not take ${itemName} from that container.`);
  } finally {
    if (container) container.close();
  }
}

async function storeInContainer(username, requestedName, requestedCount) {
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 64) {
    bot.chat('Choose a number from 1 to 64 items.');
    return;
  }

  const itemName = requestedName.replace(/^minecraft:/, '');
  const itemType = bot.registry.itemsByName[itemName];
  if (!itemType) {
    bot.chat(`I do not know an item called "${requestedName}".`);
    return;
  }

  const stacks = bot.inventory.items().filter((item) => item.type === itemType.id);
  if (stacks.length === 0) {
    bot.chat(`I do not have any ${itemName} to store.`);
    return;
  }

  const stack = stacks[0];
  const stackNbt = JSON.stringify(stack.nbt ?? null);
  const available = stacks
    .filter((item) => item.metadata === stack.metadata && JSON.stringify(item.nbt ?? null) === stackNbt)
    .reduce((total, item) => total + item.count, 0);

  if (available < requestedCount) {
    bot.chat(`I have ${available} ${itemName}; you asked me to store ${requestedCount}.`);
    return;
  }

  let container;
  try {
    container = await openTargetContainer(username);
    if (!container) return;
    await container.deposit(stack.type, stack.metadata, requestedCount, stack.nbt ?? null);
    bot.chat(`I stored ${requestedCount} ${itemName} in the container, ${username}.`);
  } catch (error) {
    console.error('Could not store item in container:', error.message);
    bot.chat(`I could not store ${itemName} in that container.`);
  } finally {
    if (container) container.close();
  }
}

async function equipItem(username, requestedName) {
  const itemName = requestedName.replace(/^minecraft:/, '');
  const itemType = bot.registry.itemsByName[itemName];
  if (!itemType) {
    bot.chat(`I do not know an item called "${requestedName}".`);
    return;
  }

  const item = bot.inventory.items().find((stack) => stack.type === itemType.id);
  if (!item) {
    bot.chat(`I do not have any ${itemName} in my inventory.`);
    return;
  }

  try {
    await bot.equip(item, 'hand');
    bot.chat(`I am holding ${itemName}, ${username}.`);
  } catch (error) {
    console.error('Could not equip item:', error.message);
    bot.chat(`I could not equip ${itemName}.`);
  }
}

async function craftItemFromInventory(username, requestedName, requestedCount) {
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 256) {
    bot.chat('Choose a number from 1 to 256 items.');
    return;
  }

  const itemName = requestedName.replace(/^minecraft:/, '');
  const itemType = bot.registry.itemsByName[itemName];
  if (!itemType) {
    bot.chat(`I do not know an item called "${requestedName}".`);
    return;
  }

  const craftingTableType = bot.registry.blocksByName.crafting_table;
  let craftingTable = craftingTableType
    ? bot.findBlock({ matching: craftingTableType.id, maxDistance: 10 })
    : null;
  const recipes = bot.recipesFor(itemType.id, null, requestedCount, craftingTable || null);

  if (recipes.length === 0) {
    bot.chat(`I cannot craft ${requestedCount} ${itemName}; I may need more materials or a nearby crafting table.`);
    return;
  }

  const recipe = recipes[0];
  const craftCount = Math.ceil(requestedCount / recipe.result.count);
  const producedCount = craftCount * recipe.result.count;
  let activeCraftingTable = recipe.requiresTable ? craftingTable : null;

  const requestId = ++movementRequestId;
  miningRequestId += 1;
  if (combatShieldActive || bowUseActive) {
    bot.deactivateItem();
    combatShieldActive = false;
    bowUseActive = false;
  }
  setPathTraversal();
  if (bot.targetDigBlock) bot.stopDigging();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  bot.chat(`Crafting ${producedCount} ${itemName}, ${username}.`);

  try {
    if (recipe.requiresTable && activeCraftingTable) {
      const tableDistance = bot.entity.position.distanceTo(activeCraftingTable.position.offset(0.5, 0.5, 0.5));
      if (tableDistance > 4.5) {
        bot.chat('Moving closer to the crafting table.');
        await bot.pathfinder.goto(new goals.GoalNear(activeCraftingTable.position.x, activeCraftingTable.position.y, activeCraftingTable.position.z, 3));
        if (requestId !== movementRequestId) return;
        activeCraftingTable = bot.blockAt(activeCraftingTable.position);
        if (!activeCraftingTable || activeCraftingTable.name !== 'crafting_table') {
          bot.chat('I could not reach the crafting table.');
          return;
        }
      }
    }

    await bot.craft(recipe, craftCount, activeCraftingTable);
    if (requestId === movementRequestId) bot.chat(`I crafted ${producedCount} ${itemName}, ${username}.`);
  } catch (error) {
    if (requestId === movementRequestId) {
      console.error('Could not craft item:', error.message);
      bot.chat(`I could not craft ${itemName}. Check my materials and crafting space.`);
    }
  }
}

function inventoryCount(itemName) {
  const item = bot.registry.itemsByName[itemName];
  return item ? bot.inventory.count(item.id, null) : 0;
}

function woodenToolRecipeCandidates(itemId, requestedCount) {
  const tableType = bot.registry.blocksByName.crafting_table;
  const hasTable = Boolean((tableType && bot.findBlock({ matching: tableType.id, maxDistance: 10 }))
    || inventoryCount('crafting_table'));
  return bot.recipesAll(itemId, null, {})
    .map((recipe) => {
      const ingredients = recipe.delta.filter((entry) => entry.count < 0);
      const plankIngredient = ingredients
        .map((entry) => ({ ...entry, name: bot.registry.items[entry.id]?.name }))
        .find((entry) => entry.name?.endsWith('_planks'));
      if (!plankIngredient) return null;
      const species = plankIngredient.name.slice(0, -'_planks'.length);
      const stickIngredient = ingredients.find((entry) => bot.registry.items[entry.id]?.name === 'stick');
      const sourceNames = [`${species}_log`, `${species}_stem`, `${species}_wood`, `stripped_${species}_log`, `stripped_${species}_wood`];
      const sourceName = sourceNames.find((name) => bot.registry.blocksByName[name]);
      if (!sourceName) return null;
      const sourceBlock = bot.registry.blocksByName[sourceName];
      const positions = bot.findBlocks({ matching: sourceBlock.id, maxDistance: 80, count: 16 });
      const nearestDistance = positions.length
        ? Math.min(...positions.map((position) => bot.entity.position.distanceTo(position)))
        : Infinity;
      const planks = inventoryCount(plankIngredient.name);
      const logs = inventoryCount(sourceName);
      const craftCount = Math.ceil(requestedCount / recipe.result.count);
      const plankRequirement = -plankIngredient.count * craftCount;
      const stickRequirement = stickIngredient ? -stickIngredient.count * craftCount : 0;
      const stickCrafts = Math.ceil(Math.max(0, stickRequirement - inventoryCount('stick')) / 4);
      const tableRequirement = recipe.requiresTable && !hasTable ? 4 : 0;
      const logsNeeded = Math.ceil(Math.max(0, plankRequirement + stickCrafts * 2 + tableRequirement - planks) / 4);
      const missingLogs = Math.max(0, logsNeeded - logs);
      const sourceAvailable = positions.length > 0;
      const score = (missingLogs > 0 && !sourceAvailable ? -100 : 0)
        - missingLogs * 8
        + planks * 0.2
        + logs * 3
        + (sourceAvailable ? 12 - nearestDistance * 0.1 : 0);
      return {
        recipe,
        species,
        plankName: plankIngredient.name,
        plankCount: -plankIngredient.count,
        stickCount: stickIngredient ? -stickIngredient.count : 0,
        resultCount: recipe.result.count,
        sourceName,
        sourceCount: positions.length,
        score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

async function placeCraftingTableFromInventory(username) {
  const tableType = bot.registry.itemsByName.crafting_table;
  const tableItem = tableType && bot.inventory.items().find((item) => item.type === tableType.id);
  if (!tableItem) return null;

  const feet = bot.entity.position.floored();
  const candidates = [];
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      if (dx === 0 && dz === 0) continue;
      const base = bot.blockAt(feet.offset(dx, -1, dz));
      const target = bot.blockAt(feet.offset(dx, 0, dz));
      if (base?.boundingBox !== 'block' || !target || target.boundingBox !== 'empty' || /water|lava/.test(target.name)) continue;
      candidates.push({ base, distance: bot.entity.position.distanceTo(base.position.offset(0.5, 1, 0.5)) });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);

  for (const { base } of candidates) {
    try {
      await bot.equip(tableItem, 'hand');
      await bot.placeBlock(base, placementFaces[BlockFace.TOP]);
      const placed = bot.blockAt(base.position.offset(0, 1, 0));
      if (placed?.name === 'crafting_table') {
        bot.chat(`I placed a crafting table nearby, ${username}.`);
        return placed;
      }
    } catch (error) {
      console.error('Could not place crafting table at a candidate position:', error.message);
    }
  }
  bot.chat('I could not find a safe, clear spot to place the crafting table.');
  return null;
}

async function craftItem(username, requestedName, requestedCount) {
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 256) {
    bot.chat('Choose a number from 1 to 256 items.');
    return;
  }

  const itemName = requestedName.replace(/^minecraft:/, '');
  const itemType = bot.registry.itemsByName[itemName];
  if (!itemType) {
    bot.chat(`I do not know an item called "${requestedName}".`);
    return;
  }

  const missingTarget = Math.max(0, requestedCount - inventoryCount(itemName));
  if (!missingTarget) {
    bot.chat(`I already have ${requestedCount} ${itemName}, ${username}.`);
    return;
  }

  const isWoodenTool = /^(wooden|wood)_(pickaxe|axe|shovel|sword|hoe)$/.test(itemName);
  const candidates = isWoodenTool ? woodenToolRecipeCandidates(itemType.id, missingTarget) : [];
  if (!candidates.length) {
    await craftItemFromInventory(username, itemName, missingTarget);
    return;
  }

  const selected = candidates[0];
  const craftsNeeded = Math.ceil(missingTarget / selected.resultCount);
  const pickPlanksNeeded = selected.plankCount * craftsNeeded;
  const sticksNeeded = selected.stickCount * craftsNeeded;
  const stickCrafts = Math.ceil(Math.max(0, sticksNeeded - inventoryCount('stick')) / 4);
  const tableBlockType = bot.registry.blocksByName.crafting_table;
  const nearbyTable = tableBlockType && bot.findBlock({ matching: tableBlockType.id, maxDistance: 10 });
  const tableInInventory = inventoryCount('crafting_table') > 0;
  const needsTable = selected.recipe.requiresTable && !nearbyTable;
  const tablePlanksNeeded = needsTable && !tableInInventory ? 4 : 0;
  const planksAvailable = inventoryCount(selected.plankName);
  const planksNeeded = Math.max(0, pickPlanksNeeded + stickCrafts * 2 + tablePlanksNeeded - planksAvailable);
  const logsNeeded = Math.ceil(planksNeeded / 4);
  const logsAvailable = inventoryCount(selected.sourceName);
  const logsToGather = Math.max(0, logsNeeded - logsAvailable);

  bot.chat(`I will make ${missingTarget} ${itemName}: get wood, craft the needed parts, set up a crafting table if needed, then finish the tool.`);
  actionManager.update(`Planning a crafting chain for ${itemName}`);

  if (logsToGather > 0) {
    if (!selected.sourceCount) {
      bot.chat(`I need ${selected.sourceName.replaceAll('_', ' ')} to continue, but I cannot find any within 80 blocks.`);
      return;
    }
    actionManager.update(`Gathering ${logsToGather} ${selected.sourceName}`);
    bot.chat(`Gathering ${logsToGather} ${selected.sourceName.replaceAll('_', ' ')} for the crafting plan.`);
    await gatherBlocks(username, selected.sourceName, logsToGather);
    if (inventoryCount(selected.sourceName) < logsNeeded) {
      bot.chat(`I could not gather enough ${selected.sourceName.replaceAll('_', ' ')} to finish the plan.`);
      return;
    }
  }

  if (planksNeeded > 0) {
    actionManager.update(`Crafting ${selected.plankName}`);
    await craftItemFromInventory(username, selected.plankName, planksNeeded);
    if (inventoryCount(selected.plankName) < pickPlanksNeeded + stickCrafts * 2 + tablePlanksNeeded) {
      bot.chat(`I could not make enough ${selected.plankName.replaceAll('_', ' ')} to continue.`);
      return;
    }
  }

  let craftingTable = nearbyTable;
  if (selected.recipe.requiresTable && !craftingTable) {
    if (!tableInInventory) {
      actionManager.update('Crafting a crafting table');
      await craftItemFromInventory(username, 'crafting_table', 1);
      if (!inventoryCount('crafting_table')) {
        bot.chat('I could not craft the crafting table needed for this tool.');
        return;
      }
    }
    actionManager.update('Placing a crafting table nearby');
    craftingTable = await placeCraftingTableFromInventory(username);
    if (!craftingTable) return;
  }

  if (stickCrafts > 0) {
    actionManager.update(`Crafting ${stickCrafts * 4} sticks`);
    await craftItemFromInventory(username, 'stick', sticksNeeded - inventoryCount('stick'));
    if (inventoryCount('stick') < sticksNeeded) {
      bot.chat(`I could not make enough sticks to finish ${itemName}.`);
      return;
    }
  }

  actionManager.update(`Crafting ${itemName}`);
  await craftItemFromInventory(username, itemName, missingTarget);
  if (inventoryCount(itemName) < requestedCount) {
    bot.chat(`The crafting sequence stopped before I had ${requestedCount} ${itemName}.`);
  }
}

async function eatFood(username, requestedName) {
  if (bot.food >= 20) {
    bot.chat(`I'm not hungry, ${username}.`);
    return;
  }

  const unsafeFoods = new Set(['rotten_flesh', 'pufferfish', 'poisonous_potato', 'raw_chicken', 'spider_eye', 'suspicious_stew']);
  const requestedItemName = requestedName?.replace(/^minecraft:/, '');
  const requestedItemType = requestedItemName ? bot.registry.itemsByName[requestedItemName] : null;
  if (requestedItemName && !requestedItemType) {
    bot.chat(`I do not know an item called "${requestedName}".`);
    return;
  }

  const initialInventory = bot.inventory.items();
  if (requestedItemType) {
    const requestedFood = initialInventory.find((item) => item.type === requestedItemType.id);
    if (!requestedFood) {
      bot.chat(`I do not have any ${requestedItemName} in my inventory.`);
      return;
    }
    if (!bot.registry.foods[requestedFood.type]) {
      bot.chat(`${requestedItemName} is not edible.`);
      return;
    }
  } else if (!initialInventory.some((item) => bot.registry.foods[item.type] && !unsafeFoods.has(item.name))) {
    bot.chat('I do not have any safe food in my inventory.');
    return;
  }

  const previousHeld = bot.heldItem;
  let eatenCount = 0;
  let lastFoodName;
  try {
    while (bot.food < 20) {
      const inventory = bot.inventory.items();
      const food = requestedItemType
        ? inventory.find((item) => item.type === requestedItemType.id)
        : inventory
          .filter((item) => bot.registry.foods[item.type] && !unsafeFoods.has(item.name))
          .sort((a, b) => bot.registry.foods[b.type].effectiveQuality - bot.registry.foods[a.type].effectiveQuality)[0];
      if (!food) break;

      const foodLevelBefore = bot.food;
      await bot.equip(food, 'hand');
      await bot.consume();
      if (bot.food <= foodLevelBefore) break;
      eatenCount += 1;
      lastFoodName = food.name;
    }

    if (previousHeld) {
      const previousStack = bot.inventory.items().find((item) => item.type === previousHeld.type
        && item.metadata === previousHeld.metadata
        && JSON.stringify(item.nbt ?? null) === JSON.stringify(previousHeld.nbt ?? null));
      if (previousStack) await bot.equip(previousStack, 'hand');
    }

    if (eatenCount > 0) {
      const result = bot.food >= 20 ? 'I am full' : 'I ate all available food';
      bot.chat(`${result} after eating ${eatenCount} ${lastFoodName}${eatenCount === 1 ? '' : ' items'}, ${username}.`);
    } else {
      bot.chat(`I could not eat ${requestedItemName || 'food'}.`);
    }
  } catch (error) {
    console.error('Could not eat food:', error.message);
    bot.chat(`I could not finish eating, ${username}.`);
  }
}

async function healWithGoldenApple(username) {
  if (bot.health >= 20) {
    bot.chat(`I am already at full health, ${username}.`);
    return;
  }

  const inventory = bot.inventory.items();
  const apple = inventory.find((item) => item.name === 'golden_apple')
    || inventory.find((item) => item.name === 'enchanted_golden_apple');
  if (!apple) {
    bot.chat('I need a golden apple to heal.');
    return;
  }

  const previousHeld = bot.heldItem;
  try {
    await bot.equip(apple, 'hand');
    await bot.consume();
    if (previousHeld) {
      const previousStack = bot.inventory.items().find((item) => item.type === previousHeld.type
        && item.metadata === previousHeld.metadata
        && JSON.stringify(item.nbt ?? null) === JSON.stringify(previousHeld.nbt ?? null));
      if (previousStack) await bot.equip(previousStack, 'hand');
    }
    bot.chat(`I ate a ${apple.name.replaceAll('_', ' ')} to recover health, ${username}.`);
  } catch (error) {
    console.error('Could not use a golden apple:', error.message);
    bot.chat('I could not use the golden apple.');
  }
}

async function sleepInNearbyBed(username) {
  if (bot.isSleeping) {
    bot.chat(`I am already sleeping, ${username}.`);
    return;
  }
  const isNight = bot.time?.timeOfDay >= 12_541 && bot.time?.timeOfDay <= 23_458;
  if (!isNight && !(bot.isRaining && bot.thunderState > 0)) {
    bot.chat('I can only sleep at night or during a thunderstorm.');
    return;
  }

  const bed = bot.findBlock({ matching: (block) => bot.isABed(block), maxDistance: 32 });
  if (!bed) {
    bot.chat('I cannot find a bed within 32 blocks.');
    return;
  }

  const requestId = ++movementRequestId;
  setPathTraversal();
  try {
    if (bot.entity.position.distanceTo(bed.position.offset(0.5, 0, 0.5)) > 3.5) {
      bot.chat('Moving to the nearby bed.');
      await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
    }
    if (requestId !== movementRequestId) return;
    await bot.sleep(bot.blockAt(bed.position));
    if (requestId === movementRequestId) bot.chat(`I am sleeping now, ${username}. Use !nova wake to get me up.`);
  } catch (error) {
    if (requestId === movementRequestId) {
      console.error('Could not sleep in nearby bed:', error.message);
      bot.chat('I could not sleep. The bed may be obstructed, occupied, or unsafe.');
    }
  }
}

async function wakeFromBed(username) {
  if (!bot.isSleeping) {
    bot.chat(`I am already awake, ${username}.`);
    return;
  }
  try {
    await bot.wake();
    bot.chat(`I am awake, ${username}.`);
  } catch (error) {
    console.error('Could not wake from bed:', error.message);
    bot.chat('I could not get out of bed.');
  }
}

function nearestHostile(requestedName) {
  const normalizedName = requestedName?.replace(/^minecraft:/, '').replaceAll('_', ' ');
  return Object.values(bot.entities)
    .filter((entity) => entity.type === 'hostile' && entity.position
      && (!normalizedName || entity.name === normalizedName || entity.displayName?.toLowerCase() === normalizedName))
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
}

function nearestNamedMob(requestedName) {
  const normalizedName = String(requestedName || '')
    .replace(/^minecraft:/, '')
    .replaceAll('_', ' ')
    .trim()
    .toLowerCase();
  if (!normalizedName) return null;

  return Object.values(bot.entities)
    .filter((entity) => ['hostile', 'passive', 'animal', 'mob'].includes(entity.type)
      && entity.position
      && (entity.name?.replace(/^minecraft:/, '').replaceAll('_', ' ').toLowerCase() === normalizedName
        || entity.displayName?.replaceAll('_', ' ').toLowerCase() === normalizedName))
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
}

const armorSlots = [
  { destination: 'head', slot: 5, suffix: '_helmet' },
  { destination: 'torso', slot: 6, suffix: '_chestplate' },
  { destination: 'legs', slot: 7, suffix: '_leggings' },
  { destination: 'feet', slot: 8, suffix: '_boots' },
];

function armorRank(itemName) {
  const material = itemName.replace(/_(helmet|chestplate|leggings|boots)$/, '');
  return ({ leather: 1, golden: 2, chainmail: 3, turtle: 3, iron: 4, diamond: 5, netherite: 6 })[material] || 0;
}

async function equipBestArmor(username, announce = true) {
  const inventory = bot.inventory.items();
  const equipped = [];
  for (const slot of armorSlots) {
    const current = bot.inventory.slots[slot.slot];
    const best = inventory
      .filter((item) => item.name.endsWith(slot.suffix))
      .sort((a, b) => armorRank(b.name) - armorRank(a.name))[0];
    if (best && armorRank(best.name) > armorRank(current?.name || '')) {
      await bot.equip(best, slot.destination);
      equipped.push(best.name);
    }
  }
  if (announce) {
    bot.chat(equipped.length
      ? `I equipped my best available armor: ${equipped.join(', ')}, ${username}.`
      : inventory.some((item) => armorSlots.some((slot) => item.name.endsWith(slot.suffix)))
        || armorSlots.some((slot) => bot.inventory.slots[slot.slot])
        ? `I am already wearing my best available armor, ${username}.`
        : `I do not have any armor to equip, ${username}.`);
  }
  return equipped;
}

async function defendAgainstHostile(username, requestedName, { allowPassive = false } = {}) {
  const target = allowPassive ? nearestNamedMob(requestedName) : nearestHostile(requestedName);
  if (!target) {
    bot.chat(requestedName
      ? `I cannot see a ${allowPassive ? 'mob' : 'hostile mob'} called ${requestedName} nearby.`
      : 'I cannot see a hostile mob nearby.');
    return;
  }

  const requestId = ++movementRequestId;
  miningRequestId += 1;
  if (combatShieldActive || bowUseActive) {
    bot.deactivateItem();
    combatShieldActive = false;
    bowUseActive = false;
  }
  setPathTraversal();
  if (bot.targetDigBlock) bot.stopDigging();
  bot.clearControlStates();

  let shieldActive = false;
  try {
    await equipBestArmor(username, false);
    const weapons = bot.inventory.items()
      .filter((item) => /_(sword|axe)$/.test(item.name) || ['trident', 'mace'].includes(item.name))
      .sort((a, b) => weaponRank(b.name) - weaponRank(a.name));
    if (weapons[0]) await bot.equip(weapons[0], 'hand');

    const offhand = bot.inventory.slots[45];
    const shield = bot.inventory.items().find((item) => item.name === 'shield');
    if (shield && (!offhand || offhand.name === 'shield')) {
      if (offhand?.name !== 'shield') await bot.equip(shield, 'off-hand');
      bot.activateItem(true);
      shieldActive = true;
      combatShieldActive = true;
    }

    bot.chat(`${allowPassive ? 'Attacking' : 'Defending against'} ${target.displayName || target.name}, ${username}.`);
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    const combatDeadline = Date.now() + 20_000;
    while (requestId === movementRequestId && bot.entities[target.id] && Date.now() < combatDeadline) {
      const distance = bot.entity.position.distanceTo(target.position);
      if (distance <= 3.2) {
        await bot.lookAt(target.position.offset(0, target.height ? target.height * 0.6 : 0.8, 0), true);
        if (requestId !== movementRequestId || !bot.entities[target.id]) break;
        bot.attack(target);
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    if (requestId === movementRequestId) {
      bot.pathfinder.setGoal(null);
      if (shieldActive) {
        bot.deactivateItem();
        combatShieldActive = false;
      }
      bot.chat(bot.entities[target.id]
        ? `I could not defeat the ${target.displayName || target.name} within 20 seconds.`
        : `The ${target.displayName || target.name} is defeated, ${username}.`);
    }
  } catch (error) {
    if (shieldActive) {
      bot.deactivateItem();
      combatShieldActive = false;
    }
    if (requestId === movementRequestId) {
      console.error('Could not defend against hostile mob:', error.message);
      bot.pathfinder.setGoal(null);
      bot.chat('I could not complete the attack.');
    }
  }
}

function hasClearShot(target) {
  const origin = bot.entity.position.offset(0, Number.isFinite(bot.entity.height) ? bot.entity.height * 0.85 : 1.4, 0);
  const aimAt = target.position.offset(0, target.height ? target.height * 0.55 : 1, 0);
  const direction = aimAt.minus(origin);
  const distance = direction.norm();
  const obstruction = bot.world.raycast(origin, direction.normalize(), Math.max(0, distance - 0.5));
  return !obstruction;
}

async function shootHostile(username, requestedName) {
  const target = nearestHostile(requestedName);
  if (!target) {
    bot.chat(requestedName ? `I cannot see a hostile mob called ${requestedName} nearby.` : 'I cannot see a hostile mob nearby.');
    return;
  }
  if (bot.entity.position.distanceTo(target.position) > 32) {
    bot.chat(`The ${target.displayName || target.name} is more than 32 blocks away.`);
    return;
  }
  const bow = bot.inventory.items().find((item) => item.name === 'bow');
  if (!bow) {
    bot.chat('I need a bow to shoot.');
    return;
  }
  const arrow = bot.inventory.items().find((item) => item.name.endsWith('_arrow') || item.name === 'arrow');
  if (!arrow) {
    bot.chat('I need arrows in my inventory to shoot.');
    return;
  }

  const requestId = ++movementRequestId;
  miningRequestId += 1;
  if (combatShieldActive || bowUseActive) {
    bot.deactivateItem();
    combatShieldActive = false;
    bowUseActive = false;
  }
  setPathTraversal();
  if (bot.targetDigBlock) bot.stopDigging();
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  const previousHeld = bot.heldItem;
  try {
    await bot.equip(bow, 'hand');
    if (requestId !== movementRequestId) return;
    if (!hasClearShot(target)) {
      bot.chat(`I cannot get a clear shot at the ${target.displayName || target.name}.`);
      return;
    }

    bot.chat(`Taking aim at ${target.displayName || target.name}, ${username}.`);
    const aimAt = target.position.offset(0, target.height ? target.height * 0.55 : 1, 0);
    await bot.lookAt(aimAt, true);
    if (requestId !== movementRequestId) return;
    bot.activateItem();
    bowUseActive = true;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    if (requestId !== movementRequestId) return;
    if (!bot.entities[target.id]) {
      bot.chat('The target is no longer nearby.');
      return;
    }
    const currentAimAt = target.position.offset(0, target.height ? target.height * 0.55 : 1, 0);
    await bot.lookAt(currentAimAt, true);
    if (requestId !== movementRequestId) return;
    if (!hasClearShot(target)) {
      bot.chat(`The ${target.displayName || target.name} moved behind cover; I did not fire.`);
      return;
    }
    bot.deactivateItem();
    bowUseActive = false;
    await new Promise((resolve) => setTimeout(resolve, 500));
    bot.chat(`I fired an arrow at the ${target.displayName || target.name}, ${username}.`);
  } catch (error) {
    console.error('Could not shoot hostile mob:', error.message);
    if (requestId === movementRequestId) bot.chat('I could not fire the bow.');
  } finally {
    if (bowUseActive) {
      bot.deactivateItem();
      bowUseActive = false;
    }
    if (requestId === movementRequestId && previousHeld) {
      const previousStack = bot.inventory.items().find((item) => item.type === previousHeld.type
        && item.metadata === previousHeld.metadata
        && JSON.stringify(item.nbt ?? null) === JSON.stringify(previousHeld.nbt ?? null));
      if (previousStack) await bot.equip(previousStack, 'hand').catch(() => {});
    }
  }
}

function weaponRank(name) {
  const tiers = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];
  const tier = tiers.findIndex((value) => name.startsWith(`${value}_`));
  if (name.endsWith('_sword')) return 100 + Math.max(tier, 0);
  if (name.endsWith('_axe')) return 50 + Math.max(tier, 0);
  return name === 'mace' ? 90 : name === 'trident' ? 80 : 0;
}

async function retreatFromHostile(username) {
  const threat = nearestHostile();
  if (!threat) {
    bot.chat('I cannot see a hostile mob to retreat from.');
    return;
  }

  const requestId = ++movementRequestId;
  miningRequestId += 1;
  setPathTraversal();
  if (bot.targetDigBlock) bot.stopDigging();
  bot.clearControlStates();
  bot.pathfinder.setGoal(null);

  const origin = bot.entity.position;
  const awayX = origin.x - threat.position.x;
  const awayZ = origin.z - threat.position.z;
  const length = Math.hypot(awayX, awayZ);
  const directionX = length > 0.01 ? awayX / length : Math.cos(bot.entity.yaw);
  const directionZ = length > 0.01 ? awayZ / length : Math.sin(bot.entity.yaw);
  const candidates = [];
  for (const distance of [8, 12, 16]) {
    const x = Math.floor(origin.x + directionX * distance);
    const z = Math.floor(origin.z + directionZ * distance);
    for (let y = Math.floor(origin.y) + 1; y >= Math.floor(origin.y) - 3; y -= 1) {
      const floor = bot.blockAt(new Vec3(x, y - 1, z));
      const feet = bot.blockAt(new Vec3(x, y, z));
      const head = bot.blockAt(new Vec3(x, y + 1, z));
      if (floor?.boundingBox === 'block' && feet?.boundingBox === 'empty' && head?.boundingBox === 'empty') {
        candidates.push({ x, y, z, threatDistance: new Vec3(x + 0.5, y, z + 0.5).distanceTo(threat.position) });
        break;
      }
    }
  }
  const destination = candidates.sort((a, b) => b.threatDistance - a.threatDistance)[0];
  if (!destination) {
    bot.chat('I could not find a clear safe spot nearby.');
    return;
  }

  bot.chat(`Retreating from ${threat.displayName || threat.name}, ${username}.`);
  try {
    await bot.pathfinder.goto(new goals.GoalNear(destination.x, destination.y, destination.z, 1));
    if (requestId === movementRequestId) bot.chat(`I reached a safer spot, ${username}.`);
  } catch (error) {
    if (requestId === movementRequestId) {
      console.error('Could not retreat from hostile mob:', error.message);
      bot.chat('I could not reach the safe spot.');
    }
  }
}

async function collectNearbyDrops(username, collectAll = false) {
  const startPosition = bot.entity.position.clone();
  const requestId = ++movementRequestId;
  setPathTraversal();
  const attempted = new Set();
  let collected = 0;
  const itemLimit = collectAll ? 64 : 1;

  while (collected < itemLimit && requestId === movementRequestId) {
    const droppedItem = Object.values(bot.entities)
      .filter((entity) => (entity.name === 'item' || entity.name === 'item_stack')
        && entity.position
        && startPosition.distanceTo(entity.position) <= 16
        && !attempted.has(entity.id))
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
    if (!droppedItem) break;

    attempted.add(droppedItem.id);
    const target = droppedItem.position.floored();
    if (collected === 0) {
      bot.chat(collectAll
        ? `I am collecting dropped items within 16 blocks, ${username}.`
        : `I found a dropped item. Coming to pick it up, ${username}.`);
    }

    try {
      await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 0));
      if (requestId !== movementRequestId) return;
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (requestId !== movementRequestId) return;
      if (!bot.entities[droppedItem.id]) {
        collected += 1;
        if (collectAll && collected % 5 === 0) bot.chat(`Collected ${collected} dropped item stacks so far.`);
      }
    } catch (error) {
      if (requestId !== movementRequestId) return;
      console.error('Could not collect dropped item:', error.message);
    }
  }

  if (requestId !== movementRequestId) return;
  if (collected === 0) bot.chat('I could not pick up any nearby dropped items.');
  else bot.chat(`I picked up ${collected} dropped item stack${collected === 1 ? '' : 's'}, ${username}.`);
}

bot.once('spawn', () => {
  trackActionChatMessages();
  setPathTraversal();
  bot.on('path_update', (results) => {
    trackDoorsOnPath(results);
    if (actionManager.snapshot() && Array.isArray(results.path)) {
      actionManager.update(`${results.status || 'Navigating'}: ${results.path.length} route steps`);
    }
  });
  perception?.stop();
  perception = startPerception(bot, (event) => {
    if (event.type === 'player_nearby') {
      bot.chat(`Hey ${event.username}, good to see you.`);
    } else if (event.type === 'low_health') {
      bot.chat(`I'm low on health (${event.health}/20).`);
    } else if (event.type === 'low_food') {
      bot.chat(`I'm getting hungry (${event.food}/20).`);
    } else if (event.type === 'hostile_nearby') {
      bot.chat(`There's a ${event.name} nearby (${Math.round(event.distance)} blocks).`);
    }
  });
  console.log(`Nova joined ${config.host}:${config.port} as ${config.username}.`);
  console.log(`In Minecraft chat, try: ${commandPrefix} help`);
  console.log(`Language model: ${llm.isConfigured() ? 'enabled' : 'disabled; configure LLM_ENABLED and LLM_MODEL in .env'}`);
});

bot.on('chat', (username, message) => {
  if (username === bot.username) return;

  const normalized = message.trim();
  if (!new RegExp(`^${commandPrefix}(?:\\s|$)`, 'i').test(normalized)) return;

  const request = normalized.slice(commandPrefix.length).trim().toLowerCase();

  if (/^task(?=$|[\s!,.،؟?])/i.test(request)) {
    const active = actionManager.snapshot();
    if (active) {
      const elapsed = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000));
      bot.chat(`Task #${active.id}: ${active.name} is ${active.status} (${elapsed}s). ${active.progress}${active.lastMessage ? ` | ${active.lastMessage}` : ''}`.slice(0, 240));
    } else {
      const recent = actionManager.recent()[0];
      bot.chat((recent
        ? `No active task. Last task #${recent.id} (${recent.name}) ${recent.status}: ${recent.progress}${recent.lastMessage ? ` | ${recent.lastMessage}` : ''}`
        : 'No active or recent tasks.').slice(0, 240));
    }
    return;
  }

  if (/^(approve|yes)(?=$|[\s!,.،؟?])/i.test(request)) {
    if (!pendingApproval) {
      bot.chat('There is no action waiting for approval.');
      return;
    }
    if (pendingApproval.username !== username) {
      bot.chat(`Only ${pendingApproval.username} can approve that action.`);
      return;
    }
    if (Date.now() - pendingApproval.createdAt > 60_000) {
      pendingApproval = null;
      bot.chat('That approval request expired. Please ask me again.');
      return;
    }
    const proposal = pendingApproval;
    pendingApproval = null;
    bot.chat(`Approved. I will carry out ${proposal.actions.map((action) => action.command).join(', then ')}.`);
    void (async () => {
      const results = [];
      for (const action of proposal.actions) {
        const result = await approvedToolAction(action.name, action.args, username);
        results.push({ command: action.command, result });
        if (!result.accepted || result.status !== 'completed' || actionManager.snapshot()) break;
      }
      if (results.length) await reportApprovedResults(proposal, results);
    })();
    return;
  }

  if (/^(reject|no)(?=$|[\s!,.،؟?])/i.test(request)) {
    if (!pendingApproval) bot.chat('There is no action waiting for approval.');
    else if (pendingApproval.username !== username) bot.chat(`Only ${pendingApproval.username} can reject that action.`);
    else {
      pendingApproval = null;
      bot.chat('Understood. I will not do that.');
    }
    return;
  }

  if (!request || request === 'help') {
    bot.chat('Commands: !nova status | !nova task | !nova look | !nova come | !nova go x y z | !nova follow | !nova stop | !nova fight [hostile] | !nova attack <mob> | !nova shoot [mob] | !nova retreat | !nova armor | !nova heal | !nova sleep | !nova wake | !nova interact | !nova ride | !nova dismount | !nova mine <block> [count] | !nova gather <block> [count] | !nova place <block> | !nova collect [all] | !nova open | !nova take <item> [count] | !nova store <item> [count] | !nova equip <item> | !nova craft <item> [count] | !nova eat [item] | Natural-language requests: !nova ask <message>. Use !nova approve or !nova reject to review a proposed action.');
    return;
  }

  if (/^(status|وضعیت)(?=$|[\s!,.،؟?])/i.test(request)) {
    sendStatus();
    return;
  }

  if (/^look(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('look', username, () => lookAtPlayer(username));
    return;
  }

  if (/^follow(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('follow', username, () => followPlayer(username), { persistent: true });
    return;
  }

  if (/^come(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('come', username, () => comeToPlayer(username));
    return;
  }

  const goMatch = request.match(/^go\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/i);
  if (goMatch) {
    const [x, y, z] = goMatch.slice(1).map(Number);
    const minY = bot.game.minY;
    const maxY = minY + bot.game.height - 1;

    if (Math.abs(x) > 29_999_984 || Math.abs(z) > 29_999_984 || y < minY || y > maxY) {
      bot.chat(`Those coordinates are outside the world bounds, ${username}.`);
      return;
    }

    void runAction('go', username, () => goToCoordinates(username, x, y, z));
    return;
  }

  if (/^go(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova go <x> <y> <z>, for example: !nova go 100 64 -20');
    return;
  }

  if (/^stop(?=$|[\s!,.،؟?])/i.test(request)) {
    stopCurrentAction();
    pendingApproval = null;
    bot.chat(`I stopped, ${username}.`);
    return;
  }

  if (/^ask\s+/i.test(request)) {
    void askLlm(username, request.replace(/^ask\s+/i, ''));
    return;
  }

  const fightMatch = request.match(/^fight(?:\s+([a-z0-9_:]+))?$/i);
  if (fightMatch) {
    void runAction('fight', username, () => defendAgainstHostile(username, fightMatch[1]?.toLowerCase()));
    return;
  }

  if (/^fight(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova fight [mob], for example: !nova fight zombie');
    return;
  }

  const attackMatch = request.match(/^attack\s+([a-z0-9_:]+)$/i);
  if (attackMatch) {
    const targetName = attackMatch[1].toLowerCase().replace(/^minecraft:/, '');
    void runAction(`attack ${targetName}`, username, () => defendAgainstHostile(username, targetName, { allowPassive: true }));
    return;
  }

  if (/^attack(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova attack <mob>, for example: !nova attack sheep');
    return;
  }

  const shootMatch = request.match(/^shoot(?:\s+([a-z0-9_:]+))?$/i);
  if (shootMatch) {
    void runAction('shoot', username, () => shootHostile(username, shootMatch[1]?.toLowerCase()));
    return;
  }

  if (/^shoot(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova shoot [mob], for example: !nova shoot skeleton');
    return;
  }

  if (/^retreat(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('retreat', username, () => retreatFromHostile(username));
    return;
  }

  if (/^armor(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('equip armor', username, () => equipBestArmor(username));
    return;
  }

  if (/^heal(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('heal', username, () => healWithGoldenApple(username));
    return;
  }

  if (/^sleep(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('sleep', username, () => sleepInNearbyBed(username));
    return;
  }

  if (/^wake(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('wake', username, () => wakeFromBed(username));
    return;
  }

  if (/^interact(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('interact', username, () => interactWithAimedBlock(username));
    return;
  }

  if (/^(ride|mount)(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('ride', username, () => mountNearestVehicle(username));
    return;
  }

  if (/^(dismount|unmount)(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('dismount', username, () => dismountVehicle(username));
    return;
  }

  const mineMatch = request.match(/^mine\s+([a-z0-9_:]+)(?:\s+(\d+))?$/i);
  if (mineMatch) {
    void runAction('mine', username, () => mineNearbyBlocks(username, mineMatch[1].toLowerCase(), mineMatch[2] ? Number(mineMatch[2]) : 1));
    return;
  }

  if (/^mine(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova mine <block> [count], for example: !nova mine stone 5');
    return;
  }

  const gatherMatch = request.match(/^gather\s+([a-z0-9_:]+)(?:\s+(\d+))?$/i);
  if (gatherMatch) {
    void runAction('gather', username, () => gatherBlocks(username, gatherMatch[1].toLowerCase(), gatherMatch[2] ? Number(gatherMatch[2]) : 1));
    return;
  }

  if (/^gather(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova gather <block> [count], for example: !nova gather oak_log 16');
    return;
  }

  const placeMatch = request.match(/^place\s+([a-z0-9_:]+)$/i);
  if (placeMatch) {
    void runAction('place', username, () => placeBlockFromInventory(username, placeMatch[1].toLowerCase()));
    return;
  }

  if (/^place(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova place <block>, for example: !nova place cobblestone');
    return;
  }

  const collectMatch = request.match(/^collect(?:\s+(all))?$/i);
  if (collectMatch) {
    void runAction('collect', username, () => collectNearbyDrops(username, Boolean(collectMatch[1])));
    return;
  }

  if (/^collect(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova collect or !nova collect all.');
    return;
  }

  if (/^open(?=$|[\s!,.،؟?])/i.test(request)) {
    void runAction('open container', username, () => inspectContainer(username));
    return;
  }

  const takeMatch = request.match(/^take\s+([a-z0-9_:]+)(?:\s+(\d+))?$/i);
  if (takeMatch) {
    void runAction('take items', username, () => takeFromContainer(username, takeMatch[1].toLowerCase(), takeMatch[2] ? Number(takeMatch[2]) : 1));
    return;
  }

  if (/^take(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova take <item> [count], for example: !nova take oak_log 16');
    return;
  }

  const storeMatch = request.match(/^store\s+([a-z0-9_:]+)(?:\s+(\d+))?$/i);
  if (storeMatch) {
    void runAction('store items', username, () => storeInContainer(username, storeMatch[1].toLowerCase(), storeMatch[2] ? Number(storeMatch[2]) : 1));
    return;
  }

  if (/^store(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova store <item> [count], for example: !nova store oak_log 16');
    return;
  }

  const equipMatch = request.match(/^equip\s+([a-z0-9_:]+)$/i);
  if (equipMatch) {
    void runAction('equip item', username, () => equipItem(username, equipMatch[1].toLowerCase()));
    return;
  }

  if (/^equip(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova equip <item>, for example: !nova equip iron_pickaxe');
    return;
  }

  const craftMatch = request.match(/^craft\s+([a-z0-9_:]+)(?:\s+(\d+))?$/i);
  if (craftMatch) {
    void runAction('craft', username, () => craftItem(username, craftMatch[1].toLowerCase(), craftMatch[2] ? Number(craftMatch[2]) : 1));
    return;
  }

  if (/^craft(?=$|\s)/i.test(request)) {
    bot.chat('Use !nova craft <item> [count], for example: !nova craft torch 8');
    return;
  }

  const eatMatch = request.match(/^eat(?:\s+([a-z0-9_:]+))?$/i);
  if (eatMatch) {
    void runAction('eat', username, () => eatFood(username, eatMatch[1]?.toLowerCase()));
    return;
  }

  if (/^(سلام|درود|hi|hello)(?=$|[\s!,.،؟?])/i.test(request)) {
    bot.chat(`Hello ${username}! I'm Nova, your Minecraft teammate.`);
    return;
  }

  void askLlm(username, request);
});

bot.on('kicked', (reason) => {
  console.error('Nova was kicked:', reason);
});

bot.on('error', (error) => {
  console.error('Minecraft connection error:', error.message);
});

bot.on('end', (reason) => {
  perception?.stop();
  perception = null;
  if (doorMaintenanceTimer) clearInterval(doorMaintenanceTimer);
  doorMaintenanceTimer = null;
  autoOpenedDoors.clear();
  console.log('Nova disconnected:', reason || 'connection ended');
});
