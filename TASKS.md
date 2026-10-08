# Yardmaster - task checklist

Legend: `[x]` done, `[ ]` open. Owner in brackets.

## Phase 0 - plan and contracts [lead]
- [x] Design plan with palette, type, wireframe, signature idea (DESIGN.md)
- [x] Review plan against generic defaults (DESIGN.md, last table)
- [x] Vite + TypeScript + three.js scaffold, fonts bundled (Outfit, Manrope)
- [x] Shared layout: sites, doors, rack slots, forklift nav graph, yard lanes, highways (src/core/layout.ts)
- [x] Module contracts (src/core/contracts.ts) and HUD snapshot types (src/core/types.ts)
- [x] RTS camera rig: drag pan, right-drag orbit, wheel zoom to cursor, WASD/QE, eased fly-to with arc
- [x] Picking, selection ring, hover ring, route-thread ribbon, live portrait readback
- [x] Lid-lift driver (camera distance + site proximity), active-site detection
- [x] Headless capture helper (scripts/shot.mjs)

## Phase 1 - build (parallel agents)
### Buildings and site layout [world agent]
- [ ] Sky, sun with shadow frustum following focus, hemisphere fill, sun follows clock
- [ ] Island ground, sea, river, hills, trees, clouds, highways with lane paint
- [ ] Warehouse per kind (DC, cold chain, cross-dock, hub) with distinct silhouettes
- [ ] Lid-lift: roof floats and fades, yard-side walls lower
- [ ] Dock doors (roll-up, animated), levelers, bumpers, signal lights, canopies
- [ ] Racks (instanced), floor paint for aisles and staging, chargers
- [ ] Fences, gates with booms, parking stalls, signage, rooftop units, lamp posts
- [ ] Draw-call budget: merged static geometry per material

### Vehicles [vehicles agent]
- [ ] Truck: cab + trailer variants (dry, reefer, box), wheels, lights, rear doors, carrier livery
- [ ] Forklift: chassis, overhead guard, mast with stages, carriage + forks, driver, beacon
- [ ] Pallet renderer: instanced wood base + cargo by kind, per-instance colour, picking
- [ ] Low draw calls (vertex colours, merged parts)

### Simulation and agents [sim agent]
- [ ] Sim clock with speed and pause, starting mid-morning shift
- [ ] Trucks: highway travel, gate, queue, reverse into dock, unload/load, depart
- [ ] Forklifts: task queue, nav graph pathing, trailer to rack, rack to trailer, charging
- [ ] Pallets: owned state, positions every frame through the instanced renderer
- [ ] Shipments between sites with stages, ETA, on-time status
- [ ] KPIs, rosters, event feed, selection details, routes for route threads

### HUD [hud agent]
- [ ] Site crest with medallion switcher (network + 4 sites)
- [ ] Sun dial clock with speed control
- [ ] Pulse strip KPIs for active site or network
- [ ] Roster drawer: docks, forklifts, trucks with live states
- [ ] Unit card with portrait lens, fields, meters
- [ ] Shipment rail tracker
- [ ] Event ticker, camera keys, world tag

## Phase 2 - integrate [lead]
- [ ] All modules wired, `npm run dev` clean, no console errors
- [ ] Typecheck and production build pass

## Phase 3 - review and polish (review agents)
- [ ] World review: detail and polish pass, fixes applied
- [ ] Vehicles review: detail and polish pass, fixes applied
- [ ] Simulation review: believability and correctness pass, fixes applied
- [ ] HUD review: craft and pixel pass, fixes applied

## Phase 4 - verify [lead]
- [ ] 60 fps on a laptop-class GPU (measured)
- [ ] Screenshots of each site from 3 angles (screenshots/), each reviewed by eye
- [ ] Interaction check: select truck, forklift, pallet, site; fly-to; roster click
