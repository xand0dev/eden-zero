import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { HumanoidSprite } from '../render/humanoid';
import { StructureSprite } from '../render/structure';
import { VegetationLayer } from '../render/vegetation';
import { CultivationLayer } from '../render/cultivation';
import { MOTOR_COUNT, MOTOR_NAMES } from '../simulation/brain/channels';
import { EntityKind } from '../shared/types';
import { PlantSpecies } from '../simulation/entities/plant';
import type { EntityView } from '../worker/client';
import type { CanalView, FieldView } from '../shared/types';

/**
 * Sprite lab — every model in the game, at the world's own scale.
 *
 * Everything here is drawn by the same classes the world renderer uses — the
 * vegetation atlas, the cultivation layer, the roundhouse and the creature rigs
 * — at one uniform scale on a patch of meadow. A lab that draws its own copies
 * drifts from the game; this one cannot.
 *
 * Open with `?lab=1`.
 */

/** Pixels per world tile in the lab. One scale for everything. */
const SCALE = 38;
/** Human sprites are drawn at this multiple of body size, as in the renderer. */
const SPRITE_SCALE = 1.45;

function label(text: string, x: number, y: number): Text {
  const node = new Text({
    text,
    style: new TextStyle({ fontFamily: 'ui-monospace, monospace', fontSize: 11, fill: '#d6e2ea' }),
  });
  node.anchor.set(0.5, 0);
  node.position.set(x, y);
  return node;
}

function entity(id: number, species: number, x: number, y: number, size: number, food: number): EntityView {
  return { id, kind: EntityKind.Plant, sex: species, x, y, size, health: food } as unknown as EntityView;
}

export function SpriteLab(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const app = new Application();
    let disposed = false;
    const world = new Container();
    const labels = new Container();
    const creatures: Array<{ sprite: HumanoidSprite; action: number; speed: number; flags: number; pregnancy: number; size: number; hue: number }> = [];
    const huts: StructureSprite[] = [];

    void app
      .init({ background: '#0b2238', width: host.clientWidth, height: host.clientHeight, antialias: true })
      .then(() => {
        if (disposed) {
          app.destroy(true);
          return;
        }
        host.appendChild(app.canvas);
        world.scale.set(SCALE);
        app.stage.addChild(world, labels);

        const meadow = new Graphics();
        meadow.rect(0, 0, 60, 40).fill(0x5d8a3c);
        for (let i = 0; i < 400; i++) {
          const x = (i * 7.37) % 60;
          const y = (i * 3.91) % 40;
          meadow.circle(x, y, 0.8 + ((i * 13) % 7) / 10).fill({ color: i % 2 ? 0x6e9a48 : 0x4e7a34, alpha: 0.35 });
        }
        world.addChild(meadow);
        const tag = (text: string, x: number, y: number): void => {
          labels.addChild(label(text, x * SCALE, y * SCALE));
        };

        // --- row 1: every action a person can take -----------------------------
        for (let action = 0; action < MOTOR_COUNT; action++) {
          const sprite = new HumanoidSprite({ baseHeight: 1 });
          const x = 2 + action * 2.3;
          sprite.position.set(x, 3.2);
          sprite.face(0);
          world.addChild(sprite);
          const walking = action <= 4;
          creatures.push({ sprite, action, speed: walking ? 1.5 : 0, flags: 0, pregnancy: 0, size: 1, hue: (action * 0.13) % 1 });
          tag(MOTOR_NAMES[action], x, 3.5);
        }

        // --- row 2: life stages, states and predators -------------------------
        const specials: Array<[string, number, number, number, number, boolean]> = [
          // name, action, flags, pregnancy, size, predator
          ['child', 0, 0, 0, 0.62, false],
          ['pregnant', 0, 8, 0.8, 1, false],
          ['sleeping', 7, 2, 0, 1, false],
          ['injured', 0, 1, 0, 1, false],
          ['predator: prowl', 0, 0, 0, 1.3, true],
          ['predator: attack', 8, 32, 0, 1.3, true],
          ['predator: rest', 7, 0, 0, 1.3, true],
        ];
        specials.forEach(([name, action, flags, pregnancy, size, predator], i) => {
          const sprite = new HumanoidSprite({ baseHeight: 1, predator });
          const x = 2.5 + i * 3.4;
          sprite.position.set(x, 7.6);
          sprite.face(0);
          world.addChild(sprite);
          creatures.push({ sprite, action, speed: action === 0 ? 1.5 : 0, flags, pregnancy, size, hue: 0.07 + i * 0.11 });
          tag(name, x, 7.9);
        });

        // --- row 3: huts, and vegetation --------------------------------------
        const states: Array<[string, number, boolean]> = [
          ['hut: staked', 0.06, false],
          ['hut: rising', 0.55, false],
          ['hut: finished', 1, true],
        ];
        states.forEach(([name, progress, complete], i) => {
          const hut = new StructureSprite(i * 0.3);
          const x = 3 + i * 5;
          hut.position.set(x, 13);
          hut.update(progress, complete, 0);
          world.addChild(hut);
          huts.push(hut);
          tag(name, x, 15.2);
        });

        const vegetation = new VegetationLayer();
        const plants: Array<[string, number, number, number]> = [
          ['grass', PlantSpecies.Grass, 1, 0.9],
          ['bush', PlantSpecies.Bush, 1, 0.3],
          ['berry bush', PlantSpecies.Bush, 1, 0.9],
          ['tree', PlantSpecies.Tree, 1, 0.8],
          ['young tree', PlantSpecies.Tree, 0.35, 0.8],
          ['stump', PlantSpecies.Tree, 0.1, 0],
          ['food pile', PlantSpecies.FoodPile, 0, 1],
        ];
        vegetation.sync(
          plants.map(([name, species, size, food], i) => {
            tag(name, 18.5 + i * 3, 14.6);
            return entity(i + 1, species, 18.5 + i * 3, 13.2, size, food);
          }),
        );
        world.addChild(vegetation.shadows, vegetation.ground, vegetation.canopy);

        // --- row 4: fields and canals -----------------------------------------
        const cultivation = new CultivationLayer();
        const fieldStates: Array<[string, number, number, number]> = [
          ['fallow, wet', 0, 0, 0.9],
          ['fallow, dry', 0, 0, 0.15],
          ['sown', 1, 0.15, 0.7],
          ['growing', 1, 0.6, 0.7],
          ['nearly ripe', 1, 0.9, 0.5],
          ['ripe', 2, 1, 0.6],
          ['growing, dry', 1, 0.5, 0.12],
        ];
        const fields: FieldView[] = fieldStates.map(([name, stage, growth, moisture], i) => {
          tag(name, 2.5 + i * 3.8, 21.2);
          return { id: 100 + i, x: 2.5 + i * 3.8, y: 19.4, stage, growth, moisture } as unknown as FieldView;
        });
        const canal = (id: number, x: number, y: number, progress: number, flowing: boolean): CanalView =>
          ({ id, x, y, progress, complete: progress >= 1, flowing }) as unknown as CanalView;
        const canals: CanalView[] = [];
        for (let i = 0; i < 5; i++) canals.push(canal(200 + i, 3 + i * 2.4, 24.5, 1, false));
        for (let i = 0; i < 5; i++) canals.push(canal(300 + i, 17 + i * 2.4, 24.5 + (i % 2) * 0.6, 1, true));
        for (let i = 0; i < 4; i++) canals.push(canal(400 + i, 31 + i * 2.4, 24.5, i < 2 ? 1 : 0.2 + i * 0.2, false));
        tag('canal: dug, dry', 7.8, 25.6);
        tag('canal: flowing', 21.8, 25.8);
        tag('canal: being dug', 34.6, 25.6);
        cultivation.update(fields, canals, null);
        world.addChildAt(cultivation.container, 1);
      });

    let raf = 0;
    let last = performance.now();
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      for (const c of creatures) {
        c.sprite.update(dt, c.action, c.speed, c.flags, c.pregnancy, 0, c.size * SPRITE_SCALE, c.hue, 0.5, 0.55);
      }
      for (const hut of huts) hut.animate(dt);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      app.destroy(true, { children: true });
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0b2238' }}>
      <div style={{ padding: '10px 14px', color: '#c7d6e2', font: '13px ui-monospace, monospace' }}>
        Sprite lab — every model, drawn by the game&apos;s own renderers at one world scale ({SCALE}px per tile).
      </div>
      <div ref={hostRef} style={{ position: 'absolute', inset: '40px 0 0 0' }} />
    </div>
  );
}
