import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { TILE } from '../shared/constants';
import { EntityKind } from '../shared/types';
import type { EntityView } from '../worker/client';
import { HumanoidSprite, hslToHex } from './humanoid';
import { StructureSprite } from './structure';
import { interpolatePose, smoothInterval, snapshotAlpha } from './interpolate';
import { TILE_NAMES, type TerrainData } from '../simulation/environment/terrain';
import { PLANT_SPECIES_NAMES, PlantSpecies, SPECIES_PROFILES } from '../simulation/entities/plant';
import type { StructureView, WorldEffect } from '../shared/types';

/**
 * PixiJS world renderer.
 *
 * Design notes:
 *  - The terrain and the vegetation layer are drawn into small offscreen
 *    canvases (one pixel per tile) and uploaded as textures. That keeps tens of
 *    thousands of tiles and plants to two draw calls, which is what makes the
 *    world view cheap enough to leave the simulation thread plenty of headroom.
 *  - Entities get real pooled sprites because they need articulation.
 *  - The camera supports pan, zoom and follow, and exposes screen<->world
 *    conversion so the god tools can target the world by clicking.
 */

const TERRAIN_COLORS: Record<number, [number, number, number]> = {
  0: [22, 44, 74], // deep water
  1: [38, 74, 104], // shallow
  2: [140, 126, 92], // sand
  3: [46, 62, 44], // grass
  4: [32, 48, 36], // forest floor
  5: [64, 62, 64], // rock
};

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface RendererCallbacks {
  onSelect(id: number | null): void;
  onWorldClick(x: number, y: number, id: number | null): void;
  onFps(fps: number): void;
}

/**
 * Visual size multiplier applied to humanoid sprites.
 *
 * A human occupies well under one tile of world space. Drawn at true scale the
 * inhabitants are barely a dozen pixels tall and the observer cannot tell who is
 * doing what. This is a readability decision, not a simulation one — the
 * simulation never sees it.
 */
const SPRITE_SCALE = 1.45;

export class WorldRenderer {
  readonly app = new Application();
  private readonly root = new Container();
  private readonly terrainLayer = new Container();
  private readonly plantLayer = new Container();
  /**
   * Structures sit between vegetation and the inhabitants, so a hut is drawn
   * over the grass it stands on but a human walking past it is drawn on top.
   */
  private readonly structureLayer = new Container();
  private readonly structures = new Map<number, StructureSprite>();
  private readonly entityLayer = new Container();
  private readonly effectLayer = new Container();

  private terrainSprite: Sprite | null = null;
  private plantSprite: Sprite | null = null;
  private plantTexture: Texture | null = null;
  private plantCanvas: HTMLCanvasElement | null = null;
  private plantContext: CanvasRenderingContext2D | null = null;

  private readonly humanSprites = new Map<number, HumanoidSprite>();
  private readonly predatorSprites = new Map<number, HumanoidSprite>();
  private readonly spritePool: HumanoidSprite[] = [];
  /** Previous frame positions, used to derive locomotion speed for animation. */

  private readonly effects = new Map<number, { graphic: Graphics; kind: string }>();
  private readonly selectionRing = new Graphics();
  private readonly nightOverlay = new Graphics();

  private terrain: TerrainData | null = null;
  private terrainTexture: Texture | null = null;

  camera: Camera = { x: 90, y: 64, zoom: 1 };
  followId: number | null = null;

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  private dragging = false;
  private dragMoved = false;
  private lastPointer = { x: 0, y: 0 };
  private pointerDownAt = { x: 0, y: 0 };

  private lastPlantRedraw = 0;
  private cameraFramed = false;

  // --- snapshot interpolation ---------------------------------------------
  /** Entities from the previous snapshot, keyed by id, for interpolation. */
  private previousById = new Map<number, EntityView>();
  /** performance.now() when the most recent snapshot was applied. */
  private snapshotAt = 0;
  /** Smoothed gap between snapshots, in milliseconds. */
  private snapshotIntervalMs = 0;
  private frameCount = 0;
  private fpsAccumulator = 0;
  private lastFpsTime = 0;
  private currentLight = 0.6;
  private selectedId: number | null = null;
  private lastEntities: EntityView[] = [];

  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;

  constructor(private readonly callbacks: RendererCallbacks) {}

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      background: 0x04060a,
      antialias: true,
      // Deliberately NOT using Pixi's `resizeTo` option. Its ResizePlugin holds
      // an internal cancel callback that is torn down by `app.destroy()`, and
      // React StrictMode mounts, unmounts and remounts effects in development —
      // so the plugin's observer can fire against an already-destroyed
      // application and throw "this._cancelResize is not a function", blanking
      // the entire UI. Managing the resize ourselves is both simpler and safe.
      width: Math.max(320, container.clientWidth || 960),
      height: Math.max(240, container.clientHeight || 640),
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      powerPreference: 'high-performance',
    });

    if (this.destroyed) {
      this.app.destroy(true, { children: true });
      return;
    }

    container.appendChild(this.app.canvas);

    this.resizeObserver = new ResizeObserver(() => {
      if (this.destroyed) return;
      const width = Math.max(320, container.clientWidth);
      const height = Math.max(240, container.clientHeight);
      this.app.renderer.resize(width, height);
    });
    this.resizeObserver.observe(container);

    this.root.addChild(this.terrainLayer, this.plantLayer, this.structureLayer, this.entityLayer, this.effectLayer);
    // The selection ring lives in world space (inside `root`); the day/night
    // wash is a screen-space overlay and must NOT inherit the camera transform.
    this.root.addChild(this.selectionRing);
    this.app.stage.addChild(this.root, this.nightOverlay);

    this.selectionRing.circle(0, 0, 0.9).stroke({ color: 0xffb347, width: 0.09, alpha: 0.95 });

    this.installInput();
    this.lastFpsTime = performance.now();

    this.app.ticker.add((ticker) => this.render(ticker.deltaMS / 1000));
  }

  setTerrain(terrain: TerrainData): void {
    this.terrain = terrain;
    this.terrainTexture?.destroy(true);
    this.terrainTexture = buildTerrainTexture(terrain);
    // ---------------------------------------------------------------------
    // Coordinate convention
    //
    // World space is measured in TILES, not pixels, and `root.scale` applies
    // `TILE * zoom`. Every position and size below is therefore in tile units.
    // Mixing the two (placing a sprite at `x * TILE` while the root transform
    // also multiplies by TILE) renders the world 14x too large, which is exactly
    // how the first build managed to show nothing but a field of blue rectangles.
    // ---------------------------------------------------------------------

    if (this.terrainSprite) {
      this.terrainSprite.texture = this.terrainTexture;
    } else {
      this.terrainSprite = new Sprite(this.terrainTexture);
      this.terrainLayer.addChild(this.terrainSprite);
    }
    this.terrainSprite.width = terrain.width;
    this.terrainSprite.height = terrain.height;

    // Plant layer shares the terrain's resolution.
    this.plantCanvas = document.createElement('canvas');
    this.plantCanvas.width = terrain.width * GROUND_SCALE;
    this.plantCanvas.height = terrain.height * GROUND_SCALE;
    this.plantContext = this.plantCanvas.getContext('2d');
    this.plantTexture?.destroy(true);
    this.plantTexture = Texture.from(this.plantCanvas);
    this.plantTexture.source.scaleMode = 'nearest';
    if (this.plantSprite) {
      this.plantSprite.texture = this.plantTexture;
    } else {
      this.plantSprite = new Sprite(this.plantTexture);
      this.plantLayer.addChild(this.plantSprite);
    }
    this.plantSprite.width = terrain.width;
    this.plantSprite.height = terrain.height;

    // Only fall back to the map centre if the inhabitants have not already been
    // framed. `setTerrain` runs asynchronously after `init`, so it can land after
    // the first entity snapshot has already positioned the camera — resetting
    // here would drop the observer into the middle of the ocean.
    if (!this.cameraFramed) {
      this.camera.x = terrain.width / 2;
      this.camera.y = terrain.height / 2;
    }
    this.clampCamera();
  }

  // ---------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------

  private installInput(): void {
    const canvas = this.app.canvas;
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (event: PointerEvent) => {
      this.dragging = true;
      this.dragMoved = false;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.pointerDownAt = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', (event: PointerEvent) => {
      if (!this.dragging) return;
      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      if (Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y) > 4) {
        this.dragMoved = true;
      }
      this.lastPointer = { x: event.clientX, y: event.clientY };
      const scale = TILE * this.camera.zoom;
      this.camera.x -= dx / scale;
      this.camera.y -= dy / scale;
      this.followId = null;
      this.clampCamera();
    });

    const endDrag = (event: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer already released */
      }
      if (!this.dragMoved) {
        const rect = canvas.getBoundingClientRect();
        const world = this.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
        const hit = this.pickAt(world.x, world.y);
        this.callbacks.onSelect(hit);
        this.callbacks.onWorldClick(world.x, world.y, hit);
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener(
      'wheel',
      (event: WheelEvent) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const before = this.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
        const factor = Math.exp(-event.deltaY * 0.0014);
        this.camera.zoom = Math.max(0.35, Math.min(6, this.camera.zoom * factor));
        const after = this.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
        this.camera.x += before.x - after.x;
        this.camera.y += before.y - after.y;
        this.clampCamera();
      },
      { passive: false },
    );

    canvas.addEventListener('dblclick', () => {
      this.camera.zoom = 1;
    });
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const width = this.app.renderer.width / this.app.renderer.resolution;
    const height = this.app.renderer.height / this.app.renderer.resolution;
    const scale = TILE * this.camera.zoom;
    return {
      x: (screenX - width / 2) / scale + this.camera.x,
      y: (screenY - height / 2) / scale + this.camera.y,
    };
  }

  private pickAt(x: number, y: number): number | null {
    let bestId: number | null = null;
    let bestDistance = 1.1;
    for (const entity of this.lastEntities) {
      if (entity.kind === EntityKind.Plant) continue;
      const distance = Math.hypot(entity.x - x, entity.y - y);
      const radius = entity.kind === EntityKind.Human ? 0.7 : 0.9 * entity.size;
      if (distance < radius && distance < bestDistance) {
        bestDistance = distance;
        bestId = entity.id;
      }
    }
    return bestId;
  }

  private clampCamera(): void {
    if (!this.terrain) return;
    this.camera.x = Math.max(0, Math.min(this.terrain.width, this.camera.x));
    this.camera.y = Math.max(0, Math.min(this.terrain.height, this.camera.y));
  }

  setSelected(id: number | null): void {
    this.selectedId = id;
  }

  setFollow(id: number | null): void {
    this.followId = id;
  }

  // ---------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------

  private render(dt: number): void {
    const now = performance.now();
    this.frameCount++;
    if (now - this.lastFpsTime >= 500) {
      const fps = (this.frameCount * 1000) / (now - this.lastFpsTime);
      this.fpsAccumulator = fps;
      this.frameCount = 0;
      this.lastFpsTime = now;
      this.callbacks.onFps(fps);
    }

    if (!this.terrain) return;

    const clampedDt = Math.min(0.05, dt);
    this.updateEntities(clampedDt);

    if (now - this.lastPlantRedraw > 260) {
      this.lastPlantRedraw = now;
      this.redrawPlants();
    }

    this.updateEffects();
    this.updateOverlay();
    this.updateCamera(clampedDt);
  }

  private updateCamera(dt: number): void {
    if (this.followId !== null) {
      const target = this.lastEntities.find((entity) => entity.id === this.followId);
      if (target) {
        const lerp = Math.min(1, dt * 6);
        this.camera.x += (target.x - this.camera.x) * lerp;
        this.camera.y += (target.y - this.camera.y) * lerp;
      }
    }
    const width = this.app.renderer.width / this.app.renderer.resolution;
    const height = this.app.renderer.height / this.app.renderer.resolution;
    const scale = TILE * this.camera.zoom;
    this.root.scale.set(scale);
    this.root.position.set(
      Math.round(width / 2 - this.camera.x * scale),
      Math.round(height / 2 - this.camera.y * scale),
    );
  }

  private updateOverlay(): void {
    const width = this.app.renderer.width / this.app.renderer.resolution;
    const height = this.app.renderer.height / this.app.renderer.resolution;
    const darkness = 1 - this.currentLight;

    this.nightOverlay.clear();
    if (darkness > 0.02) {
      this.nightOverlay
        .rect(0, 0, width, height)
        .fill({ color: 0x0a1428, alpha: Math.min(0.72, darkness * 0.78) });
    }
    this.nightOverlay.position.set(0, 0);

    if (this.selectedId !== null) {
      const entity = this.lastEntities.find((item) => item.id === this.selectedId);
      if (entity) {
        this.selectionRing.visible = true;
        this.selectionRing.position.set(entity.x, entity.y);
        this.selectionRing.scale.set(
          Math.max(0.6, entity.size * (entity.kind === EntityKind.Plant ? 1.2 : 1)),
        );
      } else {
        this.selectionRing.visible = false;
      }
    } else {
      this.selectionRing.visible = false;
    }
  }

  // ---------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------

  setLight(light: number): void {
    this.currentLight = light;
  }

  onEntities(entities: EntityView[]): void {
    // Rotate the interpolation samples: what is current now becomes the previous
    // sample the renderer interpolates away from on the next frames.
    const now = performance.now();
    if (this.snapshotAt > 0) {
      this.snapshotIntervalMs = smoothInterval(this.snapshotIntervalMs, now - this.snapshotAt);
    }
    this.snapshotAt = now;

    this.previousById.clear();
    for (const entity of this.lastEntities) this.previousById.set(entity.id, entity);

    this.lastEntities = entities;

    // Frame the inhabitants the first time we see them.
    //
    // The camera otherwise starts at the geometric centre of the map, which is
    // very often open water — the observer opens a new world and sees nothing.
    if (!this.cameraFramed && entities.length > 0) {
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (const entity of entities) {
        if (entity.kind !== EntityKind.Human) continue;
        sumX += entity.x;
        sumY += entity.y;
        count++;
      }
      if (count > 0) {
        this.cameraFramed = true;
        this.camera.x = sumX / count;
        this.camera.y = sumY / count;
        // Frame the settlement rather than the whole map: at zoom 1 the world is
        // ~50 tiles wide and the inhabitants are a dozen pixels tall.
        this.camera.zoom = 1.9;
        this.clampCamera();
      }
    }
  }

  /**
   * Sync the hut layer.
   *
   * Called with the snapshot's structure list. Sprites are created on demand and
   * kept, because a hut is a lasting object: rebuilding the layer every frame
   * would both churn and lose the per-hut rotation.
   */
  setStructures(structures: StructureView[], tick: number): void {
    const seen = new Set<number>();
    for (const data of structures) {
      seen.add(data.id);
      let sprite = this.structures.get(data.id);
      if (!sprite) {
        sprite = new StructureSprite(data.id * 0.618);
        sprite.position.set(data.x, data.y);
        this.structureLayer.addChild(sprite);
        this.structures.set(data.id, sprite);
      }
      // A short pulse right after timber is laid, so building is visible even
      // when the observer is not watching a particular hut.
      const sinceBuild = tick - data.lastBuildTick;
      const pulse = sinceBuild >= 0 && sinceBuild < 30 ? 1 - sinceBuild / 30 : 0;
      sprite.update(data.wood / data.required, data.complete, pulse);
    }
    for (const [id, sprite] of this.structures) {
      if (seen.has(id)) continue;
      sprite.destroy();
      this.structures.delete(id);
    }
  }

  /**
   * Interpolated sprite positions, for verification only.
   *
   * Snapshot interpolation is the kind of feature that is easy to *claim* and hard
   * to see: at 60 fps a world that snaps to 20 Hz snapshots still looks like it is
   * moving. This accessor exists so a script can prove the rendered position
   * changes on frames where no snapshot arrived.
   */
  debugEntityPositions(): Array<{ id: number; x: number; y: number }> {
    const out: Array<{ id: number; x: number; y: number }> = [];
    for (const [id, sprite] of this.humanSprites) {
      out.push({ id, x: sprite.position.x, y: sprite.position.y });
    }
    for (const [id, sprite] of this.predatorSprites) {
      out.push({ id, x: sprite.position.x, y: sprite.position.y });
    }
    return out;
  }

  private updateEntities(dt: number): void {
    const seenHumans = new Set<number>();
    const seenPredators = new Set<number>();

    // How far through the current snapshot interval this frame sits. Snapshots
    // arrive at 20 Hz and we draw at 60 fps, so two frames out of three are drawn
    // between two known states rather than on one. Without this every entity moves
    // in three visible jumps per snapshot.
    const alpha = snapshotAlpha(performance.now() - this.snapshotAt, this.snapshotIntervalMs);
    const intervalSeconds = this.snapshotIntervalMs > 0 ? this.snapshotIntervalMs / 1000 : 0;

    for (const entity of this.lastEntities) {
      if (entity.kind === EntityKind.Plant) continue;

      const previousSample = this.previousById.get(entity.id);
      const pose = interpolatePose(previousSample, entity, alpha);

      // Locomotion speed is derived from the displacement *between snapshots*
      // rather than frame to frame: the snapshot float stride is fully allocated,
      // and a per-snapshot delta divided by the snapshot interval is the entity's
      // true speed. Measuring the rendered frames instead would report the
      // interpolation rate, not the walk.
      let speed = 0;
      if (previousSample && intervalSeconds > 0) {
        speed = Math.hypot(entity.x - previousSample.x, entity.y - previousSample.y) / intervalSeconds;
      }

      if (entity.kind === EntityKind.Human) {
        seenHumans.add(entity.id);
        const sprite = this.obtainSprite(false, entity.id);
        sprite.position.set(pose.x, pose.y);
        // Sprites are authored facing "up"; the world's heading 0 points along +x.
        sprite.rotation = pose.heading + Math.PI / 2;
        sprite.update(
          dt,
          entity.action,
          speed,
          entity.flags,
          entity.pregnancy,
          entity.mating,
          entity.size * SPRITE_SCALE,
          entity.hue,
          entity.saturation,
          entity.lightness,
        );
      } else {
        seenPredators.add(entity.id);
        const sprite = this.obtainSprite(true, entity.id);
        sprite.position.set(pose.x, pose.y);
        sprite.rotation = pose.heading + Math.PI / 2;
        sprite.update(
          dt,
          entity.action,
          speed,
          entity.flags,
          0,
          0,
          entity.size * 0.62 * SPRITE_SCALE,
          entity.hue,
          entity.saturation,
          entity.lightness,
        );
      }
    }

    this.releaseUnseen(this.humanSprites, seenHumans);
    this.releaseUnseen(this.predatorSprites, seenPredators);
  }

  private obtainSprite(predator: boolean, id: number): HumanoidSprite {
    const map = predator ? this.predatorSprites : this.humanSprites;
    let sprite = map.get(id);
    if (sprite) return sprite;
    sprite = this.spritePool.pop();
    if (!sprite) sprite = new HumanoidSprite({ baseHeight: 1, predator });
    sprite.visible = true;
    sprite.alpha = 1;
    this.entityLayer.addChild(sprite);
    map.set(id, sprite);
    return sprite;
  }

  private releaseUnseen(map: Map<number, HumanoidSprite>, seen: Set<number>): void {
    for (const [id, sprite] of map) {
      if (seen.has(id)) continue;
      this.entityLayer.removeChild(sprite);
      sprite.visible = false;
      map.delete(id);
      if (this.spritePool.length < 400) this.spritePool.push(sprite);
      else sprite.destroy();
    }
  }

  // ---------------------------------------------------------------------
  // Vegetation
  // ---------------------------------------------------------------------

  private redrawPlants(): void {
    const context = this.plantContext;
    if (!context || !this.plantCanvas || !this.plantTexture) return;
    const scale = GROUND_SCALE;
    const width = this.plantCanvas.width;
    const height = this.plantCanvas.height;
    context.clearRect(0, 0, width, height);

    for (const entity of this.lastEntities) {
      if (entity.kind !== EntityKind.Plant) continue;
      const species = entity.sex; // plant species is packed into the sex byte
      const profile = SPECIES_PROFILES[species] ?? SPECIES_PROFILES[PlantSpecies.Grass];
      const food = entity.health;
      // Grass, bush and tree are drawn at increasing footprint so a forest reads
      // as a forest at a glance.
      const size = (species === PlantSpecies.Tree ? 3 : species === PlantSpecies.Bush ? 2 : 1) * scale;
      const lightness = profile.lightness + food * 0.16;
      const color = hslToHex(profile.hue, profile.saturation, lightness);
      context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      const cx = entity.x * scale;
      const cy = entity.y * scale;
      if (species === PlantSpecies.Tree) {
        // A small canopy rather than a square.
        context.beginPath();
        context.arc(cx, cy, size * 0.5, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillRect(Math.round(cx - size / 2), Math.round(cy - size / 2), size, size);
      }
      if (species === PlantSpecies.FoodPile) {
        context.fillStyle = 'rgba(255, 150, 90, 0.9)';
        context.fillRect(Math.round(cx - scale), Math.round(cy - scale), scale * 2, scale * 2);
      }
    }
    this.plantTexture.source.update();
  }

  // ---------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------

  private updateEffects(): void {
    const seen = new Set<number>();
    for (const effect of this.pendingEffects) {
      seen.add(effect.id);
      let entry = this.effects.get(effect.id);
      if (!entry) {
        const graphic = new Graphics();
        this.effectLayer.addChild(graphic);
        entry = { graphic, kind: effect.kind };
        this.effects.set(effect.id, entry);
      }
      const progress = 1 - effect.ttl / Math.max(0.0001, effect.maxTtl);
      entry.graphic.clear();
      drawEffect(entry.graphic, effect, progress);
    }
    for (const [id, entry] of this.effects) {
      if (seen.has(id)) continue;
      this.effectLayer.removeChild(entry.graphic);
      entry.graphic.destroy();
      this.effects.delete(id);
    }
  }

  setEffects(effects: WorldEffect[]): void {
    this.pendingEffects = effects;
  }

  /** Tear down cleanly. Safe to call before or after `init` resolves. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    try {
      this.app.destroy(true, { children: true });
    } catch {
      // The application may already be partially torn down; nothing to do.
    }
  }

  private pendingEffects: WorldEffect[] = [];
}

// ---------------------------------------------------------------------------

function drawEffect(graphic: Graphics, effect: WorldEffect, progress: number): void {
  const x = effect.x;
  const y = effect.y;
  const radius = effect.radius;

  switch (effect.kind) {
    case 'lightning': {
      const alpha = 1 - progress;
      graphic
        .moveTo(x, y - 18)
        .lineTo(x - 0.8, y - 8)
        .lineTo(x + 0.6, y - 6)
        .lineTo(x, y)
        .stroke({ color: 0xdff3ff, width: 0.35, alpha });
      graphic.circle(x, y, radius * (0.35 + progress * 0.65)).stroke({
        color: 0x9fd8ff,
        width: 0.28,
        alpha: alpha * 0.8,
      });
      graphic.circle(x, y, radius * 0.28).fill({ color: 0xffffff, alpha: alpha * 0.55 });
      break;
    }
    case 'birth': {
      const alpha = 1 - progress;
      graphic.circle(x, y, radius * (0.2 + progress * 1.5)).stroke({
        color: 0xffd9a0,
        width: 0.22,
        alpha,
      });
      break;
    }
    case 'death': {
      const alpha = 1 - progress;
      graphic.circle(x, y, radius * (0.3 + progress)).stroke({ color: 0x8a2b2b, width: 0.22, alpha });
      graphic.circle(x, y, radius * 0.2).fill({ color: 0x551818, alpha: alpha * 0.5 });
      break;
    }
    case 'mating': {
      const alpha = (1 - progress) * 0.9;
      graphic.circle(x, y, radius * (0.4 + progress * 0.5)).stroke({
        color: 0xff9fb5,
        width: 0.16,
        alpha,
      });
      break;
    }
    case 'attack': {
      graphic.circle(x, y, radius * 0.5).fill({ color: 0xff5a3c, alpha: (1 - progress) * 0.5 });
      break;
    }
    case 'build': {
      // A rising ring of timber-coloured dust.
      const alpha = 1 - progress;
      graphic.circle(x, y, radius * (0.25 + progress * 1.2)).stroke({
        color: 0xc79a5c,
        width: 0.22,
        alpha,
      });
      graphic.circle(x, y, radius * 0.3).fill({ color: 0x8a6a3d, alpha: alpha * 0.35 });
      break;
    }
    default: {
      const alpha = (1 - progress) * 0.8;
      graphic.circle(x, y, radius * (0.3 + progress)).stroke({ color: 0xa8e6ff, width: 0.16, alpha });
      break;
    }
  }
}

/**
 * Pixels per tile in the offscreen terrain and vegetation canvases.
 *
 * One pixel per tile is cheap but reads as a grid of flat coloured squares. Four
 * gives enough resolution for per-pixel grain, which is what makes the ground
 * look like ground rather than like a spreadsheet.
 */
const GROUND_SCALE = 4;

/** Paint the terrain into an offscreen canvas and upload it as a texture. */
function buildTerrainTexture(terrain: TerrainData): Texture {
  const scale = GROUND_SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = terrain.width * scale;
  canvas.height = terrain.height * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable');
  const image = context.createImageData(canvas.width, canvas.height);

  for (let ty = 0; ty < terrain.height; ty++) {
    for (let tx = 0; tx < terrain.width; tx++) {
      const index = ty * terrain.width + tx;
      const tile = terrain.tiles[index];
      const base = TERRAIN_COLORS[tile] ?? [40, 40, 40];
      const shade = tile === 0 ? 1 : 1 + (terrain.elevation[index] - 0.5) * 0.28;
      const lit = [base[0] * shade, base[1] * shade, base[2] * shade];

      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          // Deterministic per-pixel grain, stable across reloads.
          const gx = tx * scale + sx;
          const gy = ty * scale + sy;
          const noise = ((gx * 73856093) ^ (gy * 19349663)) % 19;
          const jitter = (noise / 19 - 0.5) * (tile === 0 ? 6 : 16);
          const pixel = ((gy * canvas.width) + gx) * 4;
          image.data[pixel] = clampByte(lit[0] + jitter);
          image.data[pixel + 1] = clampByte(lit[1] + jitter);
          image.data[pixel + 2] = clampByte(lit[2] + jitter);
          image.data[pixel + 3] = 255;
        }
      }
    }
  }
  context.putImageData(image, 0, 0);

  // Shelter zones read as warm clearings.
  context.globalCompositeOperation = 'lighter';
  for (const shelter of terrain.shelters) {
    const cx = shelter.x * scale;
    const cy = shelter.y * scale;
    const radius = shelter.radius * scale;
    const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, 'rgba(120, 90, 50, 0.5)');
    gradient.addColorStop(1, 'rgba(120, 90, 50, 0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalCompositeOperation = 'source-over';

  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return texture;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

export { TILE_NAMES, PLANT_SPECIES_NAMES };
