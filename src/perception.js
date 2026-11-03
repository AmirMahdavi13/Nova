const INTERVAL_MS = 1000;

function snapshotWorld(bot) {
  if (!bot.entity?.position) return null;

  const position = bot.entity.position;
  const entities = Object.values(bot.entities);
  const distanceTo = (entity) => position.distanceTo(entity.position);
  const nearbyPlayers = entities
    .filter((entity) => entity.type === 'player' && entity.id !== bot.entity.id && entity.username && entity.position)
    .map((entity) => ({ username: entity.username, distance: distanceTo(entity) }))
    .filter((player) => player.distance <= 32)
    .sort((a, b) => a.distance - b.distance);
  const nearbyHostiles = entities
    .filter((entity) => entity.type === 'hostile' && entity.position)
    .map((entity) => ({ id: entity.id, name: entity.displayName || entity.name || 'hostile mob', distance: distanceTo(entity) }))
    .filter((mob) => mob.distance <= 16)
    .sort((a, b) => a.distance - b.distance);

  return {
    updatedAt: Date.now(),
    position: { x: position.x, y: position.y, z: position.z },
    dimension: bot.game.dimension || 'unknown',
    health: Number.isFinite(bot.health) ? bot.health : null,
    food: Number.isFinite(bot.food) ? bot.food : null,
    nearbyPlayers,
    nearbyHostiles,
    droppedItems: entities.filter((entity) => (entity.name === 'item' || entity.name === 'item_stack') && entity.position).length,
  };
}

function startPerception(bot, onEvent, onSnapshot = () => {}) {
  const greetedPlayers = new Set();
  let latestSnapshot = null;
  let lowHealthWarned = false;
  let lowFoodWarned = false;
  let threatNearby = false;
  let lastThreatWarningAt = 0;

  const timer = setInterval(() => {
    const snapshot = snapshotWorld(bot);
    if (!snapshot) return;

    latestSnapshot = snapshot;
    onSnapshot(snapshot);

    for (const player of snapshot.nearbyPlayers) {
      if (player.distance <= 16 && !greetedPlayers.has(player.username)) {
        greetedPlayers.add(player.username);
        onEvent({ type: 'player_nearby', username: player.username });
      }
    }

    if (snapshot.health !== null && snapshot.health <= 8 && !lowHealthWarned) {
      lowHealthWarned = true;
      onEvent({ type: 'low_health', health: snapshot.health });
    } else if (snapshot.health !== null && snapshot.health > 10) {
      lowHealthWarned = false;
    }

    if (snapshot.food !== null && snapshot.food <= 6 && !lowFoodWarned) {
      lowFoodWarned = true;
      onEvent({ type: 'low_food', food: snapshot.food });
    } else if (snapshot.food !== null && snapshot.food > 8) {
      lowFoodWarned = false;
    }

    const closeThreat = snapshot.nearbyHostiles.find((mob) => mob.distance <= 8);
    if (closeThreat && !threatNearby && Date.now() - lastThreatWarningAt > 30_000) {
      lastThreatWarningAt = Date.now();
      onEvent({ type: 'hostile_nearby', name: closeThreat.name, distance: closeThreat.distance });
    }
    threatNearby = Boolean(closeThreat);
  }, INTERVAL_MS);

  timer.unref?.();

  return {
    getSnapshot: () => latestSnapshot,
    stop: () => clearInterval(timer),
  };
}

module.exports = { startPerception };
