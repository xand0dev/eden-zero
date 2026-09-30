import { Application, ColorMatrixFilter, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { gradeMatrix, lampStrength, makeGlowTexture, makeVignetteTexture } from './lighting';
import { TILE } from '../shared/constants';
import { EntityKind } from '../shared/types';
import type { EntityView } from '../worker/client';
import { HumanoidSprite } from './humanoid';
import { VegetationLayer } from './vegetation';
import { CultivationLayer } from './cultivation';
import { GameLayer } from './gameLayer';
import { moodFor, NEUTRAL_MOOD, type Mood } from './seasons';
import type { GameView } from '../shared/types';
import { DEEP_SEA, bakeTerrain } from './terrain';
import { StructureSprite } from './structure';
import { interpolatePose, smoothInterval, snapshotAlpha } from './interpolate';
import { TILE_NAMES, type TerrainData } from '../simulation/environment/terrain';
import { PLANT_SPECIES_NAMES } from '../simulation/entities/plant';
import type { CanalView, FieldView, StructureView, WorldEffect } from '../shared/types';
import {
  CULTIVATION_COLORS,
  OUTLINE_WIDTH,
  outlineOf,
} from './style';

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
  /** Plants: shadows, ground cover and tree crowns, as three particle layers. */
  private vegetation: VegetationLayer | null = null;
  private vegetationDirty = false;
  /**
   * Structures sit between vegetation and the inhabitants, so a hut is drawn
   * over the grass it stands on but a human walking past it is drawn on top.
   */
  private readonly structureLayer = new Container();
  private readonly structures = new Map<number, StructureSprite>();
  /**
   * Fields and canals, redrawn each snapshot rather than pooled.
   *
   * A field changes appearance as it ripens and a canal as it is dug, and there
   * are tens of them rather than thousands — pooling would be more code for no
   * gain.
   */
  private readonly cultivation = new CultivationLayer();
  private readonly gameLayer = new GameLayer();
  private mood: Mood = NEUTRAL_MOOD;
  private moodKey = '';
  private labelId: number | null = null;
  private labelText = '';
  private readonly entityLayer = new Container();
  private readonly effectLayer = new Container();

  private terrainSprite: Sprite | null = null;

  private readonly humanSprites = new Map<number, HumanoidSprite>();
  private readonly predatorSprites = new Map<number, HumanoidSprite>();
  /** Recycled sprites, one pool per rig: a person and a beast are different models. */
  private readonly humanPool: HumanoidSprite[] = [];
  private readonly predatorPool: HumanoidSprite[] = [];
  /** Previous frame positions, used to derive locomotion speed for animation. */

  private readonly effects = new Map<number, { graphic: Graphics; kind: string }>();
  private readonly selectionRing = new Graphics();
  private readonly nightOverlay = new Graphics();
  /** Colour grade for the time of day, applied to the whole world. */
  private readonly grade = new ColorMatrixFilter();
  private gradedLight = -1;
  /** Lamps and hearths: drawn after the grade, additively, so they glow at night. */
  private readonly lightsLayer = new Container();
  private readonly hutLights = new Map<number, Sprite>();
  private glowTexture: Texture | null = null;
  private vignette: Sprite | null = null;

  private terrain: TerrainData | null = null;
  private terrainTexture: Texture | null = null;
  /** Two glint layers over the sea, crossfaded so the water glitters. */
  private shimmer: [Sprite, Sprite] | null = null;
  private shimmerTextures: [Texture, Texture] | null = null;
  private clock = 0;

  camera: Camera = { x: 90, y: 64, zoom: 1 };
  followId: number | null = null;
  /**
   * Where on screen a followed entity is held, as an offset from the centre in
   * CSS pixels. Zero keeps it centred; the brain view's porthole moves it into
   * the hole it cuts in the overlay.
   */
  followOffset = { x: 0, y: 0 };

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
      // The open sea, so the island sits in an ocean rather than on a black page.
      background: DEEP_SEA,
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

    // Fields and canals sit on the ground, under the huts and the inhabitants.
    // Ground up: terrain, fields and canals, cast shadows, ground cover, tree
    // crowns, huts, and the inhabitants above everything. Huts sit over the
    // crowns because a settlement buried under its own orchard is unreadable.
    this.vegetation = new VegetationLayer();
    this.root.addChild(
      this.terrainLayer,
      this.gameLayer.ground,
      this.cultivation.container,
      this.vegetation.shadows,
      this.vegetation.ground,
      this.vegetation.canopy,
      this.structureLayer,
      this.entityLayer,
      this.effectLayer,
      this.gameLayer.sky,
    );
    // The selection ring lives in world space (inside `root`); the day/night
    // wash is a screen-space overlay and must NOT inherit the camera transform.
    this.root.addChild(this.selectionRing);
    this.glowTexture = makeGlowTexture();
    this.vignette = new Sprite(makeVignetteTexture());
    this.lightsLayer.blendMode = 'add';
    this.root.filters = [this.grade];
    // Grade only what is on screen: without this the filter would render the
    // whole island off-screen at high zoom.
    this.root.filterArea = this.app.screen;
    this.app.stage.addChild(this.root, this.lightsLayer, this.nightOverlay, this.vignette);

    this.selectionRing.ellipse(0, 0, 0.62, 0.26).stroke({ color: 0xffb347, width: 0.07, alpha: 0.95 });
    this.selectionRing.ellipse(0, 0, 0.78, 0.34).stroke({ color: 0xffb347, width: 0.03, alpha: 0.45 });

    this.installInput();
    this.lastFpsTime = performance.now();

    this.app.ticker.add((ticker) => this.render(ticker.deltaMS / 1000));
  }

  setTerrain(terrain: TerrainData): void {
    this.terrain = terrain;
    this.terrainTexture?.destroy(true);
    this.shimmerTextures?.forEach((texture) => texture.destroy(true));
    const baked = bakeTerrain(terrain);
    this.terrainTexture = baked.ground;
    this.shimmerTextures = baked.shimmer;
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
    this.gameLayer.setTerrain(terrain);

    if (!this.shimmer) {
      this.shimmer = [new Sprite(baked.shimmer[0]), new Sprite(baked.shimmer[1])];
      for (const sprite of this.shimmer) {
        sprite.blendMode = 'add';
        this.terrainLayer.addChild(sprite);
      }
    }
    this.shimmer.forEach((sprite, i) => {
      sprite.texture = baked.shimmer[i];
      sprite.width = terrain.width;
      sprite.height = terrain.height;
    });

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
    // Logical (CSS) size. `renderer.width` is already logical in Pixi v8;
    // dividing it by the resolution again put the camera's centre at a quarter
    // of the screen on a Retina display (and at a third at 1.5x).
    const width = this.app.screen.width;
    const height = this.app.screen.height;
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
    this.clock += clampedDt;
    if (this.shimmer) {
      // Slow crossfade and a gentle drift: the sea glitters instead of sitting still.
      const wave = 0.5 + 0.5 * Math.sin(this.clock * 0.8);
      this.shimmer[0].alpha = 0.25 + 0.75 * wave;
      this.shimmer[1].alpha = 0.25 + 0.75 * (1 - wave);
      this.shimmer[0].x = Math.sin(this.clock * 0.23) * 0.18;
      this.shimmer[1].x = Math.cos(this.clock * 0.19) * 0.18;
    }
    this.updateEntities(clampedDt);

    // Plants change slowly; a few syncs a second keep them current.
    if (this.vegetationDirty && now - this.lastPlantRedraw > 250) {
      this.lastPlantRedraw = now;
      this.vegetationDirty = false;
      this.vegetation?.sync(this.lastEntities);
    }

    for (const sprite of this.structures.values()) sprite.animate(clampedDt);
    this.gameLayer.setZoom(this.camera.zoom);
    this.gameLayer.animate(clampedDt, this.lastEntities);
    if (this.labelId !== null) {
      const target = this.lastEntities.find((e) => e.id === this.labelId);
      if (target) {
        const sprite = this.humanSprites.get(target.id);
        this.gameLayer.setLabel(this.labelText, sprite?.x ?? target.x, sprite?.y ?? target.y);
      } else this.gameLayer.setLabel(null);
    } else this.gameLayer.setLabel(null);
    this.updateEffects();
    this.updateOverlay();
    this.updateCamera(clampedDt);
  }

  private updateCamera(dt: number): void {
    if (this.followId !== null) {
      const target = this.lastEntities.find((entity) => entity.id === this.followId);
      if (target) {
        const lerp = Math.min(1, dt * 6);
        const scale = TILE * this.camera.zoom;
        const tx = target.x - this.followOffset.x / scale;
        const ty = target.y - this.followOffset.y / scale;
        this.camera.x += (tx - this.camera.x) * lerp;
        this.camera.y += (ty - this.camera.y) * lerp;
      }
    }
    // Logical (CSS) size. `renderer.width` is already logical in Pixi v8;
    // dividing it by the resolution again put the camera's centre at a quarter
    // of the screen on a Retina display (and at a third at 1.5x).
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const scale = TILE * this.camera.zoom;
    this.root.scale.set(scale);
    this.root.position.set(
      Math.round(width / 2 - this.camera.x * scale),
      Math.round(height / 2 - this.camera.y * scale),
    );
    this.lightsLayer.scale.set(scale);
    this.lightsLayer.position.copyFrom(this.root.position);
  }

  private updateOverlay(): void {
    // `app.screen` is the logical (CSS) size, which is what a screen-space overlay
    // needs. Do NOT use `renderer.width / renderer.resolution`: in Pixi v8
    // `renderer.width` is already the logical width, so dividing by the resolution
    // halves it on any Retina display. That bug drew the night overlay over the
    // left half of the viewport only, with a hard vertical seam down the middle —
    // and it was invisible on a resolution-1 display, which is why it survived
    // every check I had.
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    if (Math.abs(this.currentLight - this.gradedLight) > 0.004 || this.moodDirty) {
      this.gradedLight = this.currentLight;
      this.moodDirty = false;
      this.grade.matrix = gradeMatrix(this.currentLight, this.mood) as unknown as typeof this.grade.matrix;
    }
    const lamps = lampStrength(this.currentLight);
    for (const light of this.hutLights.values()) {
      light.alpha = lamps * (0.85 + 0.15 * Math.sin(this.clock * 7 + light.x));
    }
    this.lightsLayer.visible = lamps > 0.01;
    if (this.vignette) {
      this.vignette.width = width;
      this.vignette.height = height;
      this.vignette.alpha = 0.55 + 0.25 * (1 - this.currentLight);
    }

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

  private moodDirty = false;

  /** The game layer's state: the season's grade, snow, fire, rain, fever. */
  setGame(game: GameView | null): void {
    this.gameLayer.setGame(game);
    if (!game) return;
    const crisis = game.crisis?.phase === 'active' ? game.crisis.kind : null;
    const key = `${game.season}|${Math.round(game.seasonPhase * 40)}|${crisis ?? ''}`;
    if (key !== this.moodKey) {
      this.moodKey = key;
      this.mood = moodFor(game.season, game.seasonPhase, crisis);
      this.moodDirty = true;
    }
  }

  setTrails(bytes: Uint8Array): void {
    this.gameLayer.setTrails(bytes);
  }

  /** Name the selected person over their head. */
  /** Show or hide the land grid overlay. */
  toggleGrid(): boolean {
    return this.gameLayer.toggleGrid();
  }

  setLabel(id: number | null, text: string): void {
    this.labelId = id;
    this.labelText = text;
  }

  /** Glide the camera to a point (the chronicle's "show me where"). */
  focusOn(x: number, y: number): void {
    this.followId = null;
    this.camera.x = x;
    this.camera.y = y;
    this.camera.zoom = Math.max(this.camera.zoom, 2.2);
    this.clampCamera();
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
    this.vegetationDirty = true;

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
        sprite = new StructureSprite(data.id * 0.618, data.kind ?? 0);
        sprite.position.set(data.x, data.y);
        this.structureLayer.addChild(sprite);
        this.structures.set(data.id, sprite);
      }
      // A short pulse right after timber is laid, so building is visible even
      // when the observer is not watching a particular hut.
      const sinceBuild = tick - data.lastBuildTick;
      const pulse = sinceBuild >= 0 && sinceBuild < 30 ? 1 - sinceBuild / 30 : 0;
      sprite.update(data.wood / data.required, data.complete, pulse, data.store ?? 0);
      const lit = (data.kind ?? 0) === 0 || data.kind === 4 || data.kind === 6;
      if (!data.complete && this.hutLights.has(data.id)) {
        this.hutLights.get(data.id)?.destroy();
        this.hutLights.delete(data.id);
      }
      if (data.complete && lit && !this.hutLights.has(data.id) && this.glowTexture) {
        const light = new Sprite(this.glowTexture);
        light.anchor.set(0.5);
        light.position.set(data.x, data.y + 0.95);
        light.width = 5.5;
        light.height = 3.6;
        this.lightsLayer.addChild(light);
        this.hutLights.set(data.id, light);
      }
    }
    for (const [id, light] of this.hutLights) {
      if (seen.has(id)) continue;
      light.destroy();
      this.hutLights.delete(id);
    }
    for (const [id, sprite] of this.structures) {
      if (seen.has(id)) continue;
      sprite.destroy();
      this.structures.delete(id);
    }
  }

  /**
   * Draw the fields and the canals feeding them.
   *
   * Colour carries the state rather than a label: bare earth is brown, a growing
   * crop greens as it fills out, and a ripe one is gold. A canal is grey until it
   * is dug through and blue once water actually reaches it, which is the visual
   * payoff for a line of work that takes a while.
   */
  setCultivation(fields: FieldView[], canals: CanalView[]): void {
    this.cultivation.update(fields, canals, this.terrain);
    if (fields.length !== this.clearingFields || this.structures.size !== this.clearingHuts) {
      this.clearingFields = fields.length;
      this.clearingHuts = this.structures.size;
      const points = fields.map((f) => ({ x: f.x, y: f.y, r: 2.1 }));
      for (const sprite of this.structures.values()) points.push({ x: sprite.x, y: sprite.y, r: 2.3 });
      this.vegetation?.setClearings(points);
      this.vegetationDirty = true;
    }
  }

  private clearingFields = -1;
  private clearingHuts = -1;

  /**
   * Interpolated sprite positions, for verification only.
   *
   * Snapshot interpolation is the kind of feature that is easy to *claim* and hard
   * to see: at 60 fps a world that snaps to 20 Hz snapshots still looks like it is
   * moving. This accessor exists so a script can prove the rendered position
   * changes on frames where no snapshot arrived.
   */
  /** Renderer sizing, for diagnosing screen-space overlay bugs. */
  debugRendererInfo(): Record<string, number> {
    const canvas = this.app.canvas as HTMLCanvasElement;
    return {
      rendererWidth: this.app.renderer.width,
      rendererHeight: this.app.renderer.height,
      resolution: this.app.renderer.resolution,
      screenWidth: this.app.screen.width,
      screenHeight: this.app.screen.height,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      overlayWidth: this.nightOverlay.getLocalBounds().width,
      overlayHeight: this.nightOverlay.getLocalBounds().height,
    };
  }

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
        // Deliberately not rotated.
        //
        // The sprite is authored as a side-on figure: head up, legs down. It used
        // to be turned to `heading + PI/2`, which laid the whole body on its side
        // whenever the human faced east or west — a walking adult rendered as
        // something crawling, which is exactly how it read. In a top-down view a
        // standing figure is the same drawing at every heading, so the rotation
        // is not just unnecessary, it is wrong.
        sprite.rotation = 0;
        sprite.face(pose.heading);
        // In competitive mode house 1 gets a cool shift so the two lineages are
        // visually distinct at a glance without losing the individual variation.
        const hue = entity.house === 1 ? (entity.hue + 0.45) % 1 : entity.hue;
        sprite.update(
          dt,
          entity.action,
          speed,
          entity.flags,
          entity.pregnancy,
          entity.mating,
          entity.size * SPRITE_SCALE,
          hue,
          entity.saturation,
          entity.lightness,
          entity.morph,
        );
      } else {
        seenPredators.add(entity.id);
        const sprite = this.obtainSprite(true, entity.id);
        sprite.position.set(pose.x, pose.y);
        sprite.rotation = 0;
        sprite.face(pose.heading);
        sprite.update(
          dt,
          entity.action,
          speed,
          entity.flags,
          0,
          0,
          entity.size * 0.85 * SPRITE_SCALE,
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
    sprite = (predator ? this.predatorPool : this.humanPool).pop();
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
      const pool = map === this.predatorSprites ? this.predatorPool : this.humanPool;
      if (pool.length < 400) pool.push(sprite);
      else sprite.destroy();
    }
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
  // Effects are laid on the ground, like everything else: ellipses squashed to
  // the view angle, thin lines, and motes that rise and fade. A thick flat ring
  // read as a UI marker stamped on the world rather than as something happening.
  const { x, y, radius, id } = effect;
  const fade = 1 - progress;
  const ease = 1 - (1 - progress) * (1 - progress);
  const ring = (r: number, color: number, width: number, alpha: number): void => {
    graphic.ellipse(x, y, r, r * 0.45).stroke({ color, width, alpha });
  };
  const motes = (count: number, color: number, rise: number, spread: number, size: number): void => {
    for (let i = 0; i < count; i++) {
      const a = ((id * 37 + i * 97) % 360) * (Math.PI / 180);
      const d = spread * (0.35 + 0.65 * ((id * 13 + i * 29) % 100) / 100);
      const px = x + Math.cos(a) * d * ease;
      const py = y + Math.sin(a) * d * 0.45 * ease - rise * ease * (0.6 + 0.4 * ((i * 7) % 5) / 5);
      graphic.circle(px, py, size * (1 - progress * 0.5)).fill({ color, alpha: fade * 0.9 });
    }
  };

  switch (effect.kind) {
    case 'lightning': {
      // A jagged bolt out of the sky, a glow around it, a scorch where it lands.
      const points: number[] = [x + 1.6, y - 22];
      let bx = x + 1.6;
      for (let i = 1; i < 9; i++) {
        const t = i / 9;
        bx += (((id * 17 + i * 53) % 100) / 100 - 0.5) * 1.6;
        points.push(bx + (x - bx) * t * t, y - 22 + 22 * t);
      }
      points.push(x, y);
      const bolt = (width: number, color: number, alpha: number): void => {
        graphic.moveTo(points[0], points[1]);
        for (let i = 2; i < points.length; i += 2) graphic.lineTo(points[i], points[i + 1]);
        graphic.stroke({ color, width, alpha, join: 'round', cap: 'round' });
      };
      const flicker = progress < 0.35 ? 1 : fade;
      bolt(1.1, 0x7fc4ff, 0.25 * flicker);
      bolt(0.38, 0xcfe9ff, 0.7 * flicker);
      bolt(0.12, 0xffffff, flicker);
      graphic.ellipse(x, y, radius * 0.5, radius * 0.22).fill({ color: 0x1a120c, alpha: 0.45 * fade });
      ring(radius * (0.3 + ease * 0.8), 0x9fd8ff, 0.14, fade * 0.8);
      graphic.ellipse(x, y, radius * 0.35 * fade, radius * 0.16 * fade).fill({ color: 0xffffff, alpha: fade * 0.6 });
      break;
    }
    case 'birth': {
      ring(radius * (0.15 + ease * 0.9), 0xffe1a8, 0.07, fade * 0.8);
      graphic.ellipse(x, y, radius * 0.45 * fade, radius * 0.2 * fade).fill({ color: 0xffd98a, alpha: fade * 0.35 });
      motes(7, 0xfff0c8, 2.2, radius * 0.7, 0.09);
      break;
    }
    case 'death': {
      ring(radius * (0.2 + ease * 0.8), 0x3a1418, 0.09, fade * 0.7);
      graphic.ellipse(x, y, radius * 0.4, radius * 0.18).fill({ color: 0x100808, alpha: fade * 0.35 });
      motes(4, 0x9aa4ad, 1.8, radius * 0.3, 0.1);
      break;
    }
    case 'mating': {
      graphic.ellipse(x, y, radius * 0.6, radius * 0.27).fill({ color: 0xff9fb5, alpha: fade * 0.16 });
      motes(4, 0xffb6c8, 1.6, radius * 0.35, 0.08);
      break;
    }
    case 'attack': {
      for (let i = 0; i < 3; i++) {
        const off = (i - 1) * 0.22;
        graphic
          .moveTo(x - 0.4 + off, y - 0.5)
          .lineTo(x + 0.3 + off, y + 0.2)
          .stroke({ color: 0xff5a3c, width: 0.07, alpha: fade });
      }
      break;
    }
    case 'build': {
      // Puffs of dust kicked up around the work.
      for (let i = 0; i < 5; i++) {
        const a = ((id * 41 + i * 72) % 360) * (Math.PI / 180);
        const d = radius * (0.25 + ease * 0.55);
        graphic
          .circle(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.45 - ease * 0.4, 0.18 + ease * 0.35)
          .fill({ color: 0xcdb48a, alpha: fade * 0.35 });
      }
      break;
    }
    default: {
      ring(radius * (0.2 + ease * 0.8), 0xa8e6ff, 0.07, fade * 0.8);
      motes(5, 0xd8f4ff, 1.4, radius * 0.5, 0.08);
      break;
    }
  }
}

export { TILE_NAMES, PLANT_SPECIES_NAMES };
