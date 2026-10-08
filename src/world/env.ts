/**
 * Sky dome, daylight (hemisphere fill + one soft-shadowed sun) and atmospheric haze.
 * The shadow camera follows the camera focus and scales with zoom, snapped to shadow texels so
 * shadows never shimmer while panning.
 */
import * as THREE from 'three';
import type { Environment } from '../core/contracts';
import { clamp, lerp, smoothstep } from '../core/geom';
import { P } from '../core/palette';
import { noRaycast } from './util';

const SHADOW_MAP = 4096;

export function buildEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Environment & { dispose(): void } {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  scene.background = new THREE.Color(P.haze);
  const fog = new THREE.Fog(P.haze, 900, 4000);
  scene.fog = fog;

  // ---- sky dome ---------------------------------------------------------------------------------
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      horizon: { value: new THREE.Color(P.haze) },
      mid: { value: new THREE.Color(P.glacier) },
      zenith: { value: new THREE.Color(0xb9dcf8) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 horizon;
      uniform vec3 mid;
      uniform vec3 zenith;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.25, h));
        c = mix(c, zenith, smoothstep(0.25, 0.9, h));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  noRaycast(sky);
  scene.add(sky);

  // ---- lights -----------------------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xf4f9ff, 0xcfe9bd, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  const sc = sun.shadow.camera;
  sc.near = 1;
  sc.far = 1600;
  scene.add(sun);
  scene.add(sun.target);

  const sunDir = new THREE.Vector3();
  const lightMat = new THREE.Matrix4();
  const lightInv = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const origin = new THREE.Vector3();
  let half = 0;

  return {
    sun,
    update(_dt, focus, viewDistance, dayFraction) {
      // Daylight only: map the 06:00-18:00 arc onto a pleasant range and hold it outside.
      const s = clamp((dayFraction - 0.25) / 0.5, 0, 1);
      const az = lerp(1.15, -1.05, s); // east (+x) in the morning, west in the evening
      const el = lerp(0.62, 1.0, Math.sin(Math.PI * s)); // ~36 deg to ~57 deg
      sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
      // Very slight warmth near the ends of the day, never orange.
      const warm = 1 - Math.sin(Math.PI * s);
      sun.color.setRGB(1, 1 - warm * 0.03, 1 - warm * 0.07);

      // Shadow frustum: tight at site zoom, wide enough to cover the island at network zoom.
      const raw = clamp(viewDistance * 0.85, 45, 640);
      const step = Math.pow(1.18, Math.round(Math.log(raw / 45) / Math.log(1.18)));
      const nextHalf = 45 * step;
      if (nextHalf !== half) {
        half = nextHalf;
        sc.left = -half;
        sc.right = half;
        sc.top = half;
        sc.bottom = -half;
        sc.far = Math.max(900, half * 2 + 600);
        sc.updateProjectionMatrix();
      }
      sun.shadow.normalBias = 0.02 + half * 0.00025;
      // Snap the focus to the shadow texel grid in light space.
      lightMat.lookAt(sunDir, origin, up);
      lightInv.copy(lightMat).invert();
      const texel = (half * 2) / SHADOW_MAP;
      tmp.set(focus.x, 0, focus.z).applyMatrix4(lightInv);
      tmp.x = Math.round(tmp.x / texel) * texel;
      tmp.y = Math.round(tmp.y / texel) * texel;
      tmp.applyMatrix4(lightMat);
      const dist = Math.max(450, half * 1.2 + 200);
      sun.target.position.copy(tmp);
      sun.position.copy(tmp).addScaledVector(sunDir, dist);
      sun.target.updateMatrixWorld();

      // Sky dome sized to sit inside the camera far plane and around the camera.
      sky.position.set(focus.x, 0, focus.z);
      sky.scale.setScalar(viewDistance * 2.5 + 900);
      // Haze only far away.
      fog.near = viewDistance * 1.5 + 380;
      fog.far = viewDistance * 4.5 + 1700;
      const fade = smoothstep((viewDistance - 100) / 600);
      hemi.intensity = lerp(1.3, 1.45, fade);
    },
    dispose() {
      sky.geometry.dispose();
      skyMat.dispose();
    },
  };
}
