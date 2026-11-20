import { describe, expect, it } from 'vitest';
import {
  BufferGeometry,
  InstancedMesh,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Texture,
} from 'three';
import { createRoom } from '@engine/room';
import type { RoomHandle } from '@engine/room';
import { ResourceRegistry } from '@engine/resources';
import type { DisposableResource } from '@engine/resources';
import { TITLE_OFFSET_ATTRIBUTE } from '@engine/titles';

/**
 * Unloading a room has to release everything that room put on the device.
 * `docs/architecture.md` §3: WebGL memory is not garbage collected, so
 * dropping the last reference to a geometry frees the JavaScript object and
 * leaves its vertex buffer resident — a leak the heap profiler cannot see,
 * paid once per room the reader walks through.
 *
 * **Counted, not spied on.** A test that asserts `dispose` was called proves
 * that a method was called; it says nothing about the resource that was never
 * registered in the first place, which is the way this actually leaks. So this
 * file does three things instead:
 *
 * 1. counts what the room created, by kind, against figures written out here;
 * 2. walks the room's scene graph and asserts that every geometry, material
 *    and texture *reachable from it* is one of the counted ones, which is what
 *    catches a resource nobody registered;
 * 3. listens for three.js' own `dispose` event — dispatched by `BufferGeometry`,
 *    `Material`, `Texture` and `InstancedMesh` themselves, not by anything in
 *    `src/` — and asserts that the set of resources that fired is the whole
 *    set that was created.
 */

/** What one room allocates. A change here is a change in device memory per room. */
const EXPECTED = {
  /** Hexagonal plate (floor and ceiling share it), wall panel, shelf board, spine, lamp globe. */
  geometries: 5,
  /** Floor, ceiling, wall, shelf board, spine, lamp globe. */
  materials: 6,
  /** The generated floor mottle. */
  textures: 1,
  /** Wall panels, shelf boards, spines, lamp globes: each carries instance buffers. */
  instancedMeshes: 4,
};

const EXPECTED_TOTAL =
  EXPECTED.geometries +
  EXPECTED.materials +
  EXPECTED.textures +
  EXPECTED.instancedMeshes;

/** Count the tracked resources by what kind of device memory they hold. */
function countByKind(tracked: readonly DisposableResource[]): Record<string, number> {
  const counts = {
    geometries: 0,
    materials: 0,
    textures: 0,
    instancedMeshes: 0,
    other: 0,
  };
  for (const resource of tracked) {
    if (resource instanceof InstancedMesh) {
      counts.instancedMeshes += 1;
    } else if (resource instanceof BufferGeometry) {
      counts.geometries += 1;
    } else if (resource instanceof Material) {
      counts.materials += 1;
    } else if (resource instanceof Texture) {
      counts.textures += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

/** Every geometry, material and texture reachable from a room's scene graph. */
function reachableResources(root: Object3D): Set<object> {
  const found = new Set<object>();
  root.traverse((node) => {
    if (!(node instanceof Mesh)) {
      return;
    }
    found.add(node.geometry);
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      found.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) {
          found.add(value);
        }
      }
    }
  });
  return found;
}

/**
 * Listen for three.js' own `dispose` event on a tracked resource.
 *
 * Narrowed by `instanceof` rather than asserted with `as`: a tracked resource
 * that cannot announce its own disposal is itself a finding, because then
 * nothing outside `src/` can tell whether it was released — so this throws
 * instead of quietly watching an object that will never speak.
 */
function onDispose(resource: DisposableResource, listener: () => void): void {
  if (resource instanceof InstancedMesh) {
    resource.addEventListener('dispose', listener);
    return;
  }
  if (resource instanceof BufferGeometry) {
    resource.addEventListener('dispose', listener);
    return;
  }
  if (resource instanceof Material) {
    resource.addEventListener('dispose', listener);
    return;
  }
  if (resource instanceof Texture) {
    resource.addEventListener('dispose', listener);
    return;
  }
  throw new Error(
    `A tracked resource does not announce its disposal: ${resource.constructor.name}`
  );
}

/** The spines' one material, which the title atlas patches. */
function spineMaterialOf(room: RoomHandle): MeshStandardMaterial {
  const { material } = room.spines;
  if (Array.isArray(material) || !(material instanceof MeshStandardMaterial)) {
    throw new Error('The spines do not carry a single standard material');
  }
  return material;
}

describe('a room nobody has read a spine of', () => {
  it('allocates no title atlas at all', () => {
    const room = createRoom(0n);

    // `../titles.ts` builds the canvas, the texture, the instance buffer and
    // the shader patch on the first shelf resolved, so a room with no titles
    // is the mesh M4 built. The figures above are therefore unchanged by M6,
    // and this is what says so.
    expect(room.titles.shelvesHeld).toEqual([]);
    expect(room.resources.size).toBe(EXPECTED_TOTAL);
    expect(room.spines.geometry.getAttribute(TITLE_OFFSET_ATTRIBUTE)).toBeUndefined();
    expect(spineMaterialOf(room).map).toBeNull();

    room.dispose();
  });
});

describe('what a room allocates', () => {
  it('registers every geometry, material and texture it creates', () => {
    const handle = createRoom(0n);

    const counts = countByKind(handle.resources.tracked);

    expect(counts).toEqual({ ...EXPECTED, other: 0 });
    expect(handle.resources.size).toBe(EXPECTED_TOTAL);
    handle.dispose();
  });

  it('leaves nothing in its scene graph unregistered', () => {
    const handle = createRoom(0n);
    const tracked = new Set<object>(handle.resources.tracked);

    const reachable = reachableResources(handle.group);

    expect(reachable.size).toBeGreaterThan(0);
    for (const resource of reachable) {
      expect(tracked.has(resource)).toBe(true);
    }
    handle.dispose();
  });
});

describe('unloading a room', () => {
  it('releases every one of the resources it created', () => {
    const handle = createRoom(0n);
    const created = [...handle.resources.tracked];
    const released: DisposableResource[] = [];
    for (const resource of created) {
      // three.js dispatches this itself from `dispose()`. Nothing in `src/`
      // raises it, so a resource the room forgot to release is silent here.
      onDispose(resource, () => {
        released.push(resource);
      });
    }

    handle.dispose();

    expect(created).toHaveLength(EXPECTED_TOTAL);
    expect(released).toHaveLength(created.length);
    expect(new Set(released)).toEqual(new Set(created));
    expect(handle.resources.size).toBe(0);
  });

  it('empties the scene graph it was holding', () => {
    const handle = createRoom(0n);
    expect(handle.group.children.length).toBeGreaterThan(0);

    handle.dispose();

    expect(handle.group.children).toHaveLength(0);
  });

  it('releases nothing a second time when unloaded twice', () => {
    const handle = createRoom(0n);
    let releases = 0;
    for (const resource of handle.resources.tracked) {
      onDispose(resource, () => {
        releases += 1;
      });
    }

    handle.dispose();
    const afterFirst = releases;
    handle.dispose();

    expect(afterFirst).toBe(EXPECTED_TOTAL);
    expect(releases).toBe(afterFirst);
  });
});

describe('the registry itself', () => {
  it('hands back what it was given, so a builder reads as one expression', () => {
    const registry = new ResourceRegistry();
    const geometry = new BufferGeometry();

    expect(registry.track(geometry)).toBe(geometry);
    expect(registry.size).toBe(1);
    registry.disposeAll();
  });

  it('releases in the reverse of the order resources were created', () => {
    const registry = new ResourceRegistry();
    const order: string[] = [];
    for (const name of ['first', 'second', 'third']) {
      registry.track({
        dispose: () => {
          order.push(name);
        },
      });
    }

    registry.disposeAll();

    expect(order).toEqual(['third', 'second', 'first']);
    expect(registry.size).toBe(0);
  });

  it('survives a resource whose dispose throws, without losing the rest', () => {
    const registry = new ResourceRegistry();
    registry.track({
      dispose: () => {
        throw new Error('device lost');
      },
    });

    expect(() => {
      registry.disposeAll();
    }).toThrow('device lost');
    // The list is cleared before anything is disposed, so a throw cannot leave
    // half-released resources behind to be released a second time.
    expect(registry.size).toBe(0);
  });
});
