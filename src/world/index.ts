/**
 * World builder: environment, island terrain, roads and the four warehouse sites.
 * Static geometry is merged per material; repeated things are instanced.
 */
import * as THREE from 'three';
import type { BuildWorld, SiteView } from '../core/contracts';
import { buildEnvironment } from './env';
import { buildRoads, roadMaterials } from './roads';
import { buildSite, createSiteMaterials, type SiteShared } from './site';
import { buildClouds, buildTerrain, buildTrees, makeTerrainCtx, updateWater } from './terrain';
import { Batch, vcMaterial } from './util';

export const buildWorld: BuildWorld = (layout, scene, renderer) => {
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  const env = buildEnvironment(scene, renderer);
  const ctx = makeTerrainCtx(layout);

  const ground = new THREE.Group();
  ground.name = 'terrain';
  group.add(ground);
  buildTerrain(layout, ctx, ground);
  buildTrees(ctx, ground);
  const clouds = buildClouds(group);

  // Roads, aprons and paint (global layers).
  const roads = buildRoads(layout, ctx);
  const rm = roadMaterials();

  // Sites.
  const decor = new Batch();
  const fencePanels = new Batch();
  const shared: SiteShared = {
    decor,
    fencePanels,
    paint: roads.paint,
    apron: roads.apron,
    roadRects: roads.rects,
    highways: layout.roads,
    materials: createSiteMaterials(),
  };
  const sites = new Map<string, SiteView>();
  for (const s of layout.sites) sites.set(s.id, buildSite(s, shared, group));

  group.add(roads.apron.mesh(rm.apron, { receive: true }));
  group.add(roads.road.mesh(rm.road, { receive: true }));
  group.add(roads.paint.mesh(rm.paint, { receive: true }));
  group.add(roads.props.mesh(shared.materials.solid, { cast: true, receive: true }));
  group.add(decor.mesh(shared.materials.solid, { cast: true, receive: true }));
  const fenceMat = vcMaterial({ transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide });
  const fence = fencePanels.mesh(fenceMat, { receive: false });
  fence.renderOrder = 1;
  group.add(fence);

  let lastDist = 400;
  const envUpdate = env.update.bind(env);
  env.update = (dt, focus, viewDistance, dayFraction) => {
    lastDist = viewDistance;
    envUpdate(dt, focus, viewDistance, dayFraction);
  };

  return {
    group,
    env,
    sites,
    update(dt, time) {
      updateWater(dt);
      clouds.update(dt, lastDist);
      for (const s of sites.values()) s.update(dt, time);
    },
  };
};
