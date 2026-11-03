# Nova

Nova is a Minecraft teammate built by AmirReza Mahdvai with Mineflayer.

## First milestone: connect and chat

1. Start the local Paper 1.21.8 server from the `server` folder and leave its console running.
2. In the project folder, run `npm start` in a second terminal.
3. Join the server as your Minecraft player and try these chat commands:
   - `!nova hello` — say hello.
   - `!nova status` — report Nova's health, hunger, position, inventory, and nearby entities.
   - `!nova look` — turn toward the player who sent the command.
   - `!nova come` — walk to the sender's current position and stop, using height-aware navigation and scaffolding when useful.
   - `!nova go <x> <y> <z>` — walk to coordinates, for example `!nova go 100 64 -20`.
   - `!nova follow` — follow the player who sent the command, smoothing the route with jumps, sturdy-block bridges/scaffolds, and safe digging when useful.
   - `!nova stop` — stop moving.
   - `!nova fight [mob]` — equip better armor and a weapon if available, block with a shield if the off-hand is free, then follow and attack the nearest visible hostile mob for up to 20 seconds; use `!nova stop` to interrupt.
   - `!nova attack <mob>` — attack a specifically named visible living mob, including passive animals such as sheep; for example, `!nova attack sheep`.
   - `!nova shoot [mob]` — fire one fully drawn arrow at the nearest hostile within 32 blocks when Nova has a bow, an arrow, and a clear line of sight; use `!nova stop` to interrupt.
   - `!nova retreat` — move away from the nearest visible hostile mob toward a nearby clear spot.
   - `!nova armor` — equip the best available armor pieces without replacing equal or better armor already worn.
   - `!nova heal` — use one golden apple, or an enchanted golden apple if no regular one is available, when Nova is injured.
   - `!nova sleep` — find and walk to a nearby bed, then sleep at night or during a thunderstorm; `!nova wake` gets Nova out of bed.
   - `!nova interact` — activate a button or lever you are looking at within 10 blocks; for a pressure plate, Nova walks onto it. Doors, trapdoors, and gates are handled automatically when they block Nova's route.
   - `!nova ride` — walk to and mount the nearest existing boat or minecart within 32 blocks; `!nova dismount` gets off when there is room.
   - `!nova mine <block> [count]` — mine up to 256 reachable nearby blocks, for example `!nova mine stone 5`.
   - `!nova gather <block> [count]` — search up to 80 blocks away, path to matching blocks, and mine up to 256, for example `!nova gather oak_log 16`.
   - `!nova place <block>` — place one block from Nova's inventory against the face you are looking at, for example `!nova place cobblestone`.
   - `!nova collect` — walk to the nearest visible dropped item and pick it up; `!nova collect all` attempts to gather up to 64 nearby item stacks within the original 16-block area.
   - `!nova open` — inspect a container you are looking at within 10 blocks; Nova walks closer if needed, reports contents without moving items, then closes it.
   - `!nova take <item> [count]` — take up to 64 of a named item from a container you are looking at within 10 blocks.
   - `!nova store <item> [count]` — store up to 64 of a named item from Nova's inventory in a container you are looking at within 10 blocks.
   - `!nova equip <item>` — equip a named item from Nova's inventory in its hand.
   - `!nova craft <item> [count]` — craft a requested amount. For wooden tools, Nova plans the missing recipe steps, gathers nearby logs, crafts planks and sticks, makes and places a crafting table when needed, then makes the requested tool.
   - `!nova eat [item]` — keep eating until full, using the best available known-safe food; specify an item such as `!nova eat bread` to use only that food.

All pathfinding commands can now use the same terrain-aware movement profile. Nova prefers walking and jumping, opens a door on its route before digging a passage, then places sturdy blocks from its inventory or digs safe route obstructions only when needed. It protects ores, storage blocks, workstations, beds, and gravity-affected blocks; it will not dig blocks at head height or above, blocks directly beside liquid, or blocks directly below a falling block. One-block towers are disabled under a low ceiling. Keep common solid blocks such as dirt, cobblestone, or stone in Nova's inventory for bridging and climbing.

When a closed door, trapdoor, or gate is part of Nova's calculated route, the pathfinder opens it automatically and strongly prefers that over digging a new passage. Nova tracks only doors that were closed and opened for its route, then closes them after passing if the doorway is clear and still within reach. It leaves doors open if another entity is in the doorway or it cannot safely close them. Digging remains a fallback when there is no practical walkable or open-door route.

Nova currently uses offline authentication to join the local development server. Keep this server private and local. Existing commands remain deterministic scripted actions. Requests that are not one of the built-in commands can be sent to an optional OpenAI-compatible LLM endpoint by writing `!nova ask <request>` or another unrecognized `!nova` request.

## Action tracking and AI requests

- `!nova task` reports the current action, recent progress, and last result.
- `!nova stop` cancels the active movement, mining, or combat action.
- Nova runs one tracked action at a time. Direct `!nova` commands are explicit player instructions and run immediately.
- When a natural-language request leads the LLM to propose game-changing actions, Nova states the proposed goal and waits. The same player can type `!nova approve` or `!nova reject`; approval expires after 60 seconds. Read-only status/task lookups and stopping do not require approval. Multi-step plans stop at the first incomplete or failed step. A crafting goal for a wooden tool is one approved task; Nova can gather nearby logs, craft intermediate materials, place a crafting table, and finish the tool as one tracked sequence.
- Nova sends the LLM only the request and a compact current-world snapshot (position, dimension, health, hunger, held item, inventory, and nearby players/hostiles). It does not yet save long-term memory or search the web.

The LLM connection uses the Chat Completions tool-calling interface. This checkout is preconfigured in the ignored local `.env` file for Ollama at `http://127.0.0.1:11434/v1` with model `qwen3:8b`. After installing Ollama, download that model with `ollama pull qwen3:8b`, then restart Nova. Ollama's model library lists the `qwen3:8b` tag (about 5.2 GB) and marks Qwen3 as tool-capable. [Model page](https://ollama.com/library/qwen3:8b) [Ollama tool support](https://ollama.com/blog/streaming-tool)

To use another local or hosted OpenAI-compatible service, edit `.env`:

```dotenv
LLM_ENABLED=true
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=your-installed-tool-capable-model
LLM_TIMEOUT_MS=45000
```

For a hosted provider, use its compatible base URL, model name, and API key. Keep `.env` private; it is ignored by Git. Leave `LLM_ENABLED=false` to run only the built-in commands. The selected model/server must support OpenAI-style function/tool calls. Natural-language processing is only triggered by messages addressed to `!nova`; regular player chat is not sent to the model.

Connection settings can be changed in a `.env` file using `.env.example` as a guide.

## Autonomous awareness

While connected, Nova refreshes a lightweight nearby-world snapshot once per second. It greets each nearby player once per session and announces low health, low hunger, or a hostile mob within 8 blocks. These are awareness alerts; Nova does not yet eat, fight, or retreat on its own.
