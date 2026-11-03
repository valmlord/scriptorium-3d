import {
  Group,
  InstancedMesh,
  MeshBasicMaterial,
  PointLight,
  SphereGeometry,
} from 'three';
import { ROOM_HEIGHT } from './constants';
import { roomInstanceMatrix } from './scratch';
import type { ResourceRegistry } from './resources';

/**
 * The room's own light: Borges' two spherical fruit, and the globes they hang
 * in so the source is somewhere the eye can find rather than nowhere.
 *
 * Per room, not per scene, because this is what makes a room a place one can
 * be inside of. The scene's ambient fill is the viewer's and persists across
 * unloads; these two go when the room goes.
 *
 * Lights themselves hold no device memory while they cast no shadows — there
 * is no shadow map to release — so nothing registers a `PointLight`. The
 * globes are meshes and do, which is why they do.
 */

/** Two, as described. Opposite the open sides, so neither doorway is backlit. */
const LAMP_COUNT = 2;
const LAMP_RADIUS = 0.055;
const LAMP_HEIGHT = ROOM_HEIGHT - 0.3;
const LAMP_OFFSET_X = 0.52;

/** Warm, and dim enough that the fog is still readable between the shelves. */
const LAMP_COLOR = 0xffd9a0;
const LAMP_INTENSITY = 2.6;
const LAMP_DISTANCE = 7;
const LAMP_DECAY = 1.65;

/** The x offset of lamp `lamp`, either side of the room's centre. */
export function lampOffsetX(lamp: number): number {
  return lamp === 0 ? -LAMP_OFFSET_X : LAMP_OFFSET_X;
}

/**
 * Build the room's lamps and register what they allocate. The returned group
 * is the caller's to add to the room.
 */
export function createLighting(registry: ResourceRegistry): Group {
  const group = new Group();
  group.name = 'lighting';

  const globeGeometry = registry.track(new SphereGeometry(LAMP_RADIUS, 16, 12));
  const globeMaterial = registry.track(new MeshBasicMaterial({ color: LAMP_COLOR }));
  const globes = registry.track(
    new InstancedMesh(globeGeometry, globeMaterial, LAMP_COUNT)
  );
  globes.name = 'lamp-globes';

  for (let lamp = 0; lamp < LAMP_COUNT; lamp += 1) {
    roomInstanceMatrix.identity().setPosition(lampOffsetX(lamp), LAMP_HEIGHT, 0);
    globes.setMatrixAt(lamp, roomInstanceMatrix);

    const light = new PointLight(LAMP_COLOR, LAMP_INTENSITY, LAMP_DISTANCE, LAMP_DECAY);
    light.position.set(lampOffsetX(lamp), LAMP_HEIGHT, 0);
    light.name = `lamp-${String(lamp)}`;
    group.add(light);
  }
  globes.instanceMatrix.needsUpdate = true;
  globes.computeBoundingSphere();
  group.add(globes);

  return group;
}
