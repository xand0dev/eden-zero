import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { GameView } from '../shared/types';
import type { EntityView } from '../worker/client';
import type { TerrainData } from '../simulation/environment/terrain';
import { makeSnowTexture, paintTrails, snowCover } from './seasons';

/**
 * What the game layer puts on the map: trails and snow on the ground, fire,
 * rain and fever above it, and the name of whoever is selected.
 *
 * Ground overlays are textures baked from the terrain and the worker's trail
 * bytes; the rest is redrawn every frame from the last game view, so a fire
 * flickers and rain falls between snapshots.
 */
export class GameLayer {
  /** Sits on the terrain, under fields and plants. */
  readonly ground = new Container();
  /** Sits above everything in the world. */
  readonly sky = new Container();

  private snow: Sprite | null = null;
  private readonly trailCanvas = document.createElement('canvas');
  private trails: Sprite | null = null;
  private trailTexture: Texture | null = null;
  private readonly fx = new Graphics();
  private readonly label = new Text({
    text: '',
    style: {
      fontFamily: 'Inter, -apple-system, sans-serif',
      fontSize: 42,
      fill: 0xf4f8fb,
      fontWeight: '600',
      stroke: { color: 0x04080d, width: 8 },
      align: 'center',
    },
  });
  private game: GameView | null = null;
  private clock = 0;

  constructor() {
    this.sky.addChild(this.fx, this.label);
    this.label.anchor.set(0.5, 1);
    this.label.scale.set(1 / 40);
    this.label.visible = false;
  }

  setTerrain(terrain: TerrainData): void {
    this.snow?.destroy({ texture: true });
    this.snow = new Sprite(makeSnowTexture(terrain));
    this.snow.width = terrain.width;
    this.snow.height = terrain.height;
    this.snow.alpha = 0;
    if (!this.trails) {
      this.trails = new Sprite(Texture.EMPTY);
      this.ground.addChild(this.trails);
    }
    this.trails.width = terrain.width;
    this.trails.height = terrain.height;
    this.ground.addChild(this.snow);
    this.width = terrain.width;
    this.height = terrain.height;
  }

  private width = 0;
  private height = 0;

  setTrails(bytes: Uint8Array): void {
    if (!this.trails || this.width === 0) return;
    paintTrails(this.trailCanvas, bytes, this.width, this.height);
    if (this.trailTexture) this.trailTexture.source.update();
    else {
      this.trailTexture = Texture.from(this.trailCanvas);
      this.trailTexture.source.scaleMode = 'linear';
      this.trails.texture = this.trailTexture;
      this.trails.width = this.width;
      this.trails.height = this.height;
    }
  }

  setGame(game: GameView | null): void {
    this.game = game;
    if (!game || !this.snow) return;
    const harsh = game.crisis?.kind === 'harshWinter' && game.crisis.phase === 'active';
    this.targetSnow = snowCover(game.season, game.seasonPhase, harsh);
  }

  private targetSnow = 0;

  setLabel(text: string | null, x = 0, y = 0): void {
    if (!text) {
      this.label.visible = false;
      return;
    }
    this.label.visible = true;
    if (this.label.text !== text) this.label.text = text;
    this.label.position.set(x, y - 1.9);
  }

  /** Redraw fire, rain and fever. `entities` gives positions for fevered people. */
  animate(dt: number, entities: EntityView[]): void {
    this.clock += dt;
    if (this.snow) this.snow.alpha += (this.targetSnow * 0.85 - this.snow.alpha) * Math.min(1, dt * 0.8);
    const g = this.fx.clear();
    const game = this.game;
    if (!game) return;

    // Fire: layered flame tongues that flicker, embers that rise, smoke above.
    for (let i = 0; i < game.fires.length; i += 2) {
      const x = game.fires[i];
      const y = game.fires[i + 1];
      const seed = x * 12.9898 + y * 78.233;
      for (let k = 0; k < 3; k++) {
        const flicker = 0.75 + 0.25 * Math.sin(this.clock * (9 + k * 3) + seed + k);
        const h = (0.9 + 0.4 * k) * flicker;
        g.ellipse(x + (k - 1) * 0.22, y - h * 0.45, 0.28 - k * 0.05, h * 0.5).fill({
          color: [0xff5a1e, 0xff9a2e, 0xffe27a][k],
          alpha: 0.75 - k * 0.12,
        });
      }
      for (let k = 0; k < 4; k++) {
        const t = (this.clock * 0.6 + k / 4 + (seed % 1)) % 1;
        g.circle(x + Math.sin(seed + k * 2 + t * 4) * 0.3, y - 1 - t * 2.4, 0.08 * (1 - t)).fill({ color: 0xffc070, alpha: 1 - t });
        g.circle(x + 0.3 + t * 0.8, y - 1.6 - t * 3, 0.35 + t * 0.6).fill({ color: 0x3a3430, alpha: 0.22 * (1 - t) });
      }
    }

    // Rain: slanted streaks falling inside the shower's footprint.
    for (const rain of game.rains) {
      const drops = Math.round(rain.radius * 9);
      g.ellipse(rain.x, rain.y, rain.radius, rain.radius * 0.5).fill({ color: 0x6fa8d8, alpha: 0.08 });
      for (let k = 0; k < drops; k++) {
        const a = (k * 2.399963) % (Math.PI * 2);
        const r = rain.radius * Math.sqrt(((k * 0.618) % 1) * 0.95);
        const px = rain.x + Math.cos(a) * r;
        const py = rain.y + Math.sin(a) * r * 0.5;
        const t = (this.clock * 1.6 + k * 0.137) % 1;
        const top = py - 6 + t * 6;
        g.moveTo(px + 0.3, top - 0.7).lineTo(px, top).stroke({ color: 0xcfe6ff, width: 0.05, alpha: 0.55 });
        if (t > 0.92) g.ellipse(px, py, 0.18, 0.07).stroke({ color: 0xcfe6ff, width: 0.03, alpha: 0.6 });
      }
    }

    // Fever: a sickly haze around the fevered.
    if (game.fevered.length > 0) {
      const fevered = new Set(game.fevered);
      for (const entity of entities) {
        if (!fevered.has(entity.id)) continue;
        const pulse = 0.5 + 0.5 * Math.sin(this.clock * 3 + entity.id);
        g.ellipse(entity.x, entity.y - 0.6, 0.7 + pulse * 0.15, 0.9).fill({ color: 0xb8d060, alpha: 0.12 + pulse * 0.08 });
      }
    }
  }
}
