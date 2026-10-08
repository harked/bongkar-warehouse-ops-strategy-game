# bongkar-warehouse-ops-strategy-game
a browser app: warehouse operations console that feels like a city-builder / RTS strategy game

**Bongkar** (Indonesian for "unload"). A living toy-diorama of a four-site warehouse network: trucks drive the
highways, reverse into docks and unload; forklifts thread the aisles moving pallets between
trailers and racks; shipments flow between sites. Built with Vite, TypeScript and three.js, with
every 3D asset made in code.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Controls

| Input | Action |
|---|---|
| Drag | Pan |
| Right-drag (or Shift-drag) | Rotate and tilt |
| Scroll | Zoom toward the cursor (zoom into a site to lift its roof) |
| WASD / arrows, Q / E | Pan, rotate |
| Click | Select a truck, forklift, pallet, dock or site |
| Double-click or F | Fly to the selection and follow it |
| [ and ] | Previous / next site |
| H | Home view for the current site |
| Space | Pause |
| 1 / 2 / 3 | Speed 1x / 4x / 12x |
| Esc | Clear selection |

## Sites

- **Pasa Ateh** - ambient distribution center
- **Ambacang** - chilled and frozen storage
- **Teluk Bayur** - flow-through, doors on both sides
- **Stasiun Tabing** - regional parcel hub

## Project layout

- `src/core` - palette, constants, site definitions, computed layout (doors, slots, nav graph, highways), shared types and module contracts
- `src/world` - environment, island, roads and site buildings
- `src/vehicles` - trucks, forklifts and the instanced pallet renderer
- `src/sim` - simulation tick, agents, shipments, KPIs and HUD snapshot
- `src/hud` - the game HUD (DOM + CSS)
- `src/scene` - camera rig, selection, route threads, live portrait

See `DESIGN.md` for the design plan and `TASKS.md` for the checklist.
