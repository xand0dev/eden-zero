import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { TILE } from '../shared/constants';
import { EntityKind } from '../shared/types';
import type { EntityView } from '../worker/client';
import { HumanoidSprite, hslToHex } from './humanoid';
import { TILE_NAMES, type TerrainData } from '../simulation/environment/terrain';
import { PLANT_SPECIES_NAMES, PlantSpecies, SPECIES_PROFILES } from '../simulation/entities/plant';
import type { WorldEffect } from '../shared/types';

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

export class WorldRenderer {
  readonly app = new Application();
  private readonly root = new Container();
  private readonly terrainLayer = new Container();
  private readonly plantLayer = new Container();
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
  private readonly lastPositions = new Map<number, { x: number; y: number }>();

  private readonly effects = new Map<number, { graphic: Graphics; kind: string }>();
  private readonly selectionRing = new Graphics();
  private readonly nightOverlay = new Graphics();

  private terrain: TerrainData | null = null;
  private terrainTexture: Texture | null = null;

  camera: Camera = { x: 90, y: 64, zoom: 1 };
  followId: number | null = null;

  private dragging = false;
  private dragMoved = false;
  private lastPointer = { x: 0, y: 0 };
  private pointerDownAt = { x: 0, y: 0 };

  private lastPlantRedraw = 0;
  private frameCount = 0;
  private fpsAccumulator = 0;
  private lastFpsTime = 0;
  private currentLight = 0.6;
  private selectedId: number | null = null;
  private lastEntities: EntityView[] = [];

  constructor(private readonly callbacks: RendererCallbacks) {}

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      background: 0x04060a,
      antialias: true,
      resizeTo: container,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      powerPreference: 'high-performance',
    });
    container.appendChild(this.app.canvas);

    this.root.addChild(this.terrainLayer, this.plantLayer, this.entityLayer, this.effectLayer);
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
    if (this.terrainSprite) {
      this.terrainSprite.texture = this.terrainTexture;
    } else {
      this.terrainSprite = new Sprite(this.terrainTexture);
      this.terrainLayer.addChild(this.terrainSprite);
    }
    this.terrainSprite.width = terrain.width * TILE;
    this.terrainSprite.height = terrain.height * TILE;

    // Plant layer shares the terrain's resolution.
    this.plantCanvas = document.createElement('canvas');
    this.plantCanvas.width = terrain.width;
    this.plantCanvas.height = terrain.height;
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
    this.plantSprite.width = terrain.width * TILE;
    this.plantSprite.height = terrain.height * TILE;

    this.camera.x = terrain.width / 2;
    this.camera.y = terrain.height / 2;
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
        this.selectionRing.position.set(entity.x * TILE, entity.y * TILE);
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
    this.lastEntities = entities;
  }

  private updateEntities(dt: number): void {
    const seenHumans = new Set<number>();
    const seenPredators = new Set<number>();

    for (const entity of this.lastEntities) {
      if (entity.kind === EntityKind.Plant) continue;

      // Locomotion speed is derived from frame-to-frame displacement rather than
      // shipped in the snapshot: the snapshot float stride is fully allocated,
      // and the renderer already has the previous position for free.
      const previous = this.lastPositions.get(entity.id);
      let speed = 0;
      if (previous && dt > 0) {
        speed = Math.hypot(entity.x - previous.x, entity.y - previous.y) / dt;
      }
      this.lastPositions.set(entity.id, { x: entity.x, y: entity.y });

      if (entity.kind === EntityKind.Human) {
        seenHumans.add(entity.id);
        const sprite = this.obtainSprite(false, entity.id);
        sprite.position.set(entity.x * TILE, entity.y * TILE);
        // Sprites are authored facing "up"; the world's heading 0 points along +x.
        sprite.rotation = entity.heading + Math.PI / 2;
        sprite.update(
          dt,
          entity.action,
          speed,
          entity.flags,
          entity.pregnancy,
          entity.mating,
          entity.size,
          entity.hue,
          entity.saturation,
          entity.lightness,
        );
      } else {
        seenPredators.add(entity.id);
        const sprite = this.obtainSprite(true, entity.id);
        sprite.position.set(entity.x * TILE, entity.y * TILE);
        sprite.rotation = entity.heading + Math.PI / 2;
        sprite.update(
          dt,
          entity.action,
          speed,
          entity.flags,
          0,
          0,
          entity.size * 0.62,
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
    const width = this.plantCanvas.width;
    const height = this.plantCanvas.height;
    context.clearRect(0, 0, width, height);

    for (const entity of this.lastEntities) {
      if (entity.kind !== EntityKind.Plant) continue;
      const species = entity.sex; // plant species is packed into the sex byte
      const profile = SPECIES_PROFILES[species] ?? SPECIES_PROFILES[PlantSpecies.Grass];
      const food = entity.health;
      const size = species === PlantSpecies.Tree ? 3 : species === PlantSpecies.Bush ? 2 : 1;
      const lightness = profile.lightness + food * 0.16;
      const color = hslToHex(profile.hue, profile.saturation, lightness);
      context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      context.fillRect(
        Math.round(entity.x - size / 2),
        Math.round(entity.y - size / 2),
        size,
        size,
      );
      if (species === PlantSpecies.FoodPile) {
        context.fillStyle = 'rgba(255, 140, 90, 0.85)';
        context.fillRect(Math.round(entity.x - 1), Math.round(entity.y - 1), 2, 2);
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

  private pendingEffects: WorldEffect[] = [];
}

// ---------------------------------------------------------------------------

function drawEffect(graphic: Graphics, effect: WorldEffect, progress: number): void {
  const x = effect.x * TILE;
  const y = effect.y * TILE;
  const radius = effect.radius * TILE;

  switch (effect.kind) {
    case 'lightning': {
      const alpha = 1 - progress;
      graphic
        .moveTo(x, y - 260)
        .lineTo(x - 10, y - 120)
        .lineTo(x + 8, y - 90)
        .lineTo(x, y)
        .stroke({ color: 0xdff3ff, width: 5, alpha });
      graphic.circle(x, y, radius * (0.35 + progress * 0.65)).stroke({
        color: 0x9fd8ff,
        width: 4,
        alpha: alpha * 0.8,
      });
      graphic.circle(x, y, radius * 0.28).fill({ color: 0xffffff, alpha: alpha * 0.55 });
      break;
    }
    case 'birth': {
      const alpha = 1 - progress;
      graphic.circle(x, y, radius * (0.2 + progress * 1.5)).stroke({
        color: 0xffd9a0,
        width: 3,
        alpha,
      });
      break;
    }
    case 'death': {
      const alpha = 1 - progress;
      graphic.circle(x, y, radius * (0.3 + progress)).stroke({ color: 0x8a2b2b, width: 3, alpha });
      graphic.circle(x, y, radius * 0.2).fill({ color: 0x551818, alpha: alpha * 0.5 });
      break;
    }
    case 'mating': {
      const alpha = (1 - progress) * 0.9;
      graphic.circle(x, y, radius * (0.4 + progress * 0.5)).stroke({
        color: 0xff9fb5,
        width: 2,
        alpha,
      });
      break;
    }
    case 'attack': {
      graphic.circle(x, y, radius * 0.5).fill({ color: 0xff5a3c, alpha: (1 - progress) * 0.5 });
      break;
    }
    default: {
      const alpha = (1 - progress) * 0.8;
      graphic.circle(x, y, radius * (0.3 + progress)).stroke({ color: 0xa8e6ff, width: 2, alpha });
      break;
    }
  }
}

/** Paint the terrain into a 1-pixel-per-tile canvas and upload it as a texture. */
function buildTerrainTexture(terrain: TerrainData): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = terrain.width;
  canvas.height = terrain.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable');
  const image = context.createImageData(terrain.width, terrain.height);

  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      const index = y * terrain.width + x;
      const tile = terrain.tiles[index];
      const base = TERRAIN_COLORS[tile] ?? [40, 40, 40];
      // Cheap deterministic texture so the ground is not a flat block of colour.
      const noise = ((x * 73856093) ^ (y * 19349663)) % 17;
      const jitter = (noise / 17 - 0.5) * 14;
      const shade = tile === 0 ? 1 : 1 + (terrain.elevation[index] - 0.5) * 0.28;
      const pixel = (y * terrain.width + x) * 4;
      image.data[pixel] = clampByte(base[0] * shade + jitter);
      image.data[pixel + 1] = clampByte(base[1] * shade + jitter);
      image.data[pixel + 2] = clampByte(base[2] * shade + jitter);
      image.data[pixel + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);

  // Shelter zones read as warm clearings.
  context.globalCompositeOperation = 'lighter';
  for (const shelter of terrain.shelters) {
    const gradient = context.createRadialGradient(
      shelter.x,
      shelter.y,
      0,
      shelter.x,
      shelter.y,
      shelter.radius,
    );
    gradient.addColorStop(0, 'rgba(120, 90, 50, 0.55)');
    gradient.addColorStop(1, 'rgba(120, 90, 50, 0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(shelter.x, shelter.y, shelter.radius, 0, Math.PI * 2);
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
