/**
 * The one vehicle shader: a MeshStandardMaterial patched so a single merged mesh can carry
 * per-unit paint, lamps that switch independently, spinning wheels, swinging doors and a lifting
 * mast. Every unit gets its own small material (uniform values) but they all share one program.
 */
import * as THREE from 'three';

export interface VehicleUniforms {
  uTravel: { value: number };
  uDoor: { value: number };
  uLift: { value: THREE.Vector3 };
  uPaintA: { value: THREE.Color };
  uPaintB: { value: THREE.Color };
  uLamp: { value: number[] };
}

const MOVE_GLSL = /* glsl */ `
attribute float aTag;
attribute vec4 aMove;
uniform float uTravel;
uniform float uDoor;
uniform vec3 uLift;
vec3 yardMove(vec3 p, bool isDir) {
  float k = aMove.x;
  if (k < 0.5) return p;
  if (k < 1.5) {
    // Wheel spin about the local X axis through (y, z) = aMove.yz, angle = travel / radius.
    float a = uTravel * aMove.w;
    float c = cos(a);
    float s = sin(a);
    vec2 q = isDir ? p.yz : p.yz - aMove.yz;
    q = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
    p.yz = isDir ? q : q + aMove.yz;
    return p;
  }
  if (k < 2.5) {
    // Door hinge about a vertical axis through (x, z) = aMove.yz, angle = uDoor * sign.
    float a = uDoor * aMove.w;
    float c = cos(a);
    float s = sin(a);
    vec2 q = isDir ? p.xz : p.xz - aMove.yz;
    q = vec2(q.x * c + q.y * s, -q.x * s + q.y * c);
    p.xz = isDir ? q : q + aMove.yz;
    return p;
  }
  // Lift: aMove.y selects the stage (0 carriage, 1 middle mast, 2 inner mast).
  if (!isDir) p.y += aMove.y < 0.5 ? uLift.x : (aMove.y < 1.5 ? uLift.y : uLift.z);
  return p;
}
`;

function patchVertex(shader: { vertexShader: string }, withTag: boolean): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${MOVE_GLSL}\n${withTag ? 'varying float vTag;' : ''}`)
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\nobjectNormal = yardMove(objectNormal, true);`)
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\ntransformed = yardMove(transformed, false);${withTag ? '\nvTag = aTag;' : ''}`,
    );
}

const FRAG_PARS = /* glsl */ `
varying float vTag;
uniform vec3 uPaintA;
uniform vec3 uPaintB;
uniform float uLamp[8];
`;

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
{
  if (vTag > 0.5 && vTag < 1.5) diffuseColor.rgb *= uPaintA;
  else if (vTag > 1.5 && vTag < 2.5) diffuseColor.rgb *= uPaintB;
  else if (vTag > 7.5) {
    float on = uLamp[int(vTag - 7.5)];
    // Lit lenses glow; unlit lenses read a touch darker so the change is obvious.
    totalEmissiveRadiance += diffuseColor.rgb * on * 2.4;
    diffuseColor.rgb *= mix(0.78, 1.0, clamp(on, 0.0, 1.0));
  }
}
`;

const FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
if (vTag > 0.5 && vTag < 2.5) roughnessFactor = 0.42;
else if (vTag > 2.5 && vTag < 3.5) roughnessFactor = 0.14;
else if (vTag > 3.5 && vTag < 4.5) roughnessFactor = 0.9;
else if (vTag > 4.5 && vTag < 5.5) roughnessFactor = 0.26;
else if (vTag > 7.5) roughnessFactor = 0.3;
`;

export interface VehicleMaterials {
  body: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
  u: VehicleUniforms;
}

export function createVehicleMaterials(paintA: number, paintB: number): VehicleMaterials {
  const u: VehicleUniforms = {
    uTravel: { value: 0 },
    uDoor: { value: 0 },
    uLift: { value: new THREE.Vector3() },
    uPaintA: { value: new THREE.Color(paintA) },
    uPaintB: { value: new THREE.Color(paintB) },
    uLamp: { value: [0, 0, 0, 0, 0, 0, 0, 0] },
  };
  const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 });
  body.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    patchVertex(shader, true);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH);
  };
  body.customProgramCacheKey = () => 'yard-vehicle-body-1';

  const depth = new THREE.MeshDepthMaterial();
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.uTravel = u.uTravel;
    shader.uniforms.uDoor = u.uDoor;
    shader.uniforms.uLift = u.uLift;
    patchVertex(shader, false);
  };
  depth.customProgramCacheKey = () => 'yard-vehicle-depth-1';
  return { body, depth, u };
}

/** Plain textured decal / plate material. Polygon offset keeps it off the panel behind it. */
export function decalMaterial(map: THREE.Texture, transparent: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    transparent,
    depthWrite: !transparent,
    roughness: 0.5,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}
