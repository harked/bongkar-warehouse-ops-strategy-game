# Yardmaster - design plan

A warehouse operations console that plays like a calm city-builder. You are not reading a
dashboard; you are looking down at a living toy diorama of your network and nudging it.

## Feeling

- Bright late-morning daylight, soft shadows, no fog of gloom.
- Toy-like low-poly: chunky bevel-free boxes, rounded silhouettes where cheap (cylinders,
  capsules), saturated but gentle colour. Everything readable at a glance from 120 m up.
- Calm motion: nothing snaps. Camera eases, doors roll, forks glide, trucks ease into docks.
- The HUD floats over the world like a strategy game: glass panels with real depth, each
  panel a different shape because each does a different job.

## Palette (named)

| Name            | Hex       | Use |
|-----------------|-----------|-----|
| Cloud           | `#FFFFFF` | Panel highlights, building walls (lit) |
| Haze            | `#EEF6FD` | Sky horizon, glass panel tint |
| Glacier         | `#D6EAFB` | Sky zenith blend, subtle fills, frost |
| Sky             | `#6CB8F0` | Secondary accent, water highlight, inbound |
| Azure           | `#2F8CE8` | Interactive hover, progress |
| Cobalt          | `#2147D9` | Primary accent: selection, active site, trims |
| Midnight Cobalt | `#13296E` | Strong text, numerals |
| Ink             | `#26354D` | Body text |
| Slate           | `#6B7C96` | Secondary text, idle states |
| Meadow          | `#A9DB8C` | Ground grass |
| Fern            | `#6DB66A` | Tree canopy light |
| Pine            | `#3E8E5E` | Tree canopy dark |
| Lagoon          | `#8FD3F4` | River and the sea around the island |
| Concrete        | `#E6EBF1` | Yards, aprons |
| Asphalt         | `#A9B4C2` | Roads (light, toy asphalt, never black) |
| Sunbeam         | `#FFC145` | Forklifts, attention, "working" |
| Coral           | `#FF6F61` | Alerts, late shipments |
| Mint            | `#2CCB94` | Healthy, on-time, done |
| Frost           | `#A8E6FF` | Cold chain accents, temperature |

Shadows in the HUD are tinted cobalt (`rgba(19,41,110,0.14)`), never neutral grey.
No cream anywhere: the light neutrals all lean cool (Haze, Glacier, Concrete).

## Type

- **Outfit** (variable) for display: site names, big numerals, clock. Geometric and friendly,
  reads like a game title without being cartoonish.
- **Manrope** (variable) for UI text: labels, rows, fields. Tabular numerals
  (`font-variant-numeric: tabular-nums`) for every changing number so digits never jitter.
- Labels are sentence case, weight 600, Slate. No monospace, no all-caps eyebrows.

## Layout wireframe

```
+--------------------------------------------------------------------------------+
|  .-Site crest------------------.    .-Pulse strip------------------.   .-Sun dial-.|
|  | (DC) Northgate DC         v |    | 412/h  8/10 docks  97%  -18C |   |  07:42   ||
|  |  o   o   o   o  network     |    '------------------------------'   | > 1x 4x  ||
|  '-----------------------------'                                       '----------'|
|                                                                                |
|  .-Roster drawer---.                                        ( portrait lens )  |
|  | Docks Lifts Trk |                                     .-Unit card-------.   |
|  | D01 ====--  ... |                                     | FL-07 Forklift  |   |
|  | D02 ==----  ... |            3D DIORAMA               | carrying, 82%   |   |
|  | ...             |                                     | fields...       |   |
|  '-----------------'                                     '-----------------'   |
|                                                                                |
|  .-Event ticker--.      .-Shipment rail: A ---o--- B ---- C ------.   .-Cam-.  |
|  '---------------'      '-----------------------------------------'   '-----'  |
+--------------------------------------------------------------------------------+
```

Panel shapes differ on purpose: the site crest is a banner with medallion tokens, the pulse
strip is a single segmented bar, the sun dial is a round-cornered clock, the roster is a
tall drawer with tabs, the unit card hangs under a round portrait lens, the shipment rail
is a long thin track.

## Signature idea: lift the lid

Every warehouse is a diorama box. When you zoom toward a site, its roof floats up and fades
like the lid of a toy box being lifted, and the near wall drops to half height, revealing the
live interior: racks filling, forklifts threading aisles, pallets moving from trailer to rack.
Zoom back out and the lid settles again. It turns "drill down" into a physical gesture.

Supporting ideas (in service of the signature, not competing with it):
- **Route threads**: selecting a truck or forklift draws its planned path in the world as a
  soft cobalt ribbon, the way an RTS shows move orders.
- **Portrait lens**: the selected unit appears in a small live 3D portrait above its card.
- **Sun follows the clock**: the sun angle drifts with simulated time of day.

## Review against generic defaults

| Generic default                         | What we do instead |
|-----------------------------------------|--------------------|
| Dark mode with neon accents             | Bright daylight diorama, cobalt on white glass |
| Cream / beige background                | Cool Haze and Glacier sky, Meadow island, Lagoon sea |
| Monospace "terminal" labels             | Outfit + Manrope, tabular numerals only where digits change |
| ALL-CAPS tracked eyebrow labels         | Sentence-case labels, hierarchy via size and weight |
| Grid of identical cards, grey shadows   | Six distinct panel shapes, cobalt-tinted layered shadows |
| Pill buttons everywhere                 | Medallions for sites, segmented control for speed, square icon keys for camera |
| Static charts                           | KPIs are gauges tied to live sim; tracker is a moving route rail |
| Generic OrbitControls feel              | RTS controls: drag pan, right-drag rotate, wheel zoom to cursor, WASD/QE, eased fly-to |
| Sidebar + top nav app shell             | Floating HUD corners, world stays full-bleed |

## Architecture

- `src/core` - palette, constants, site definitions, computed layout (doors, slots, roads,
  forklift nav graph, highway graph), shared types and module contracts. Owned by lead.
- `src/world` - environment (sky, sun, island, roads, river, trees) and site builders.
- `src/vehicles` - truck, forklift, pallet instancing; all geometry built in code.
- `src/sim` - simulation tick, agents, shipments, KPIs, view sync, HUD snapshot.
- `src/hud` - DOM HUD, reads snapshots, emits commands.
- `src/scene` - camera controller, picking, selection highlight, route threads, portrait.
- `src/main.ts` - wiring and the frame loop.
