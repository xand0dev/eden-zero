import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { HumanoidSprite } from '../render/humanoid';
import { StructureSprite } from '../render/structure';
import { CULTIVATION_COLORS, STRUCTURE_COLORS, outlineOf } from '../render/style';
import { MOTOR_COUNT, MOTOR_NAMES } from '../simulation/brain/channels';

/**
 * Sprite lab — every model in the game, laid out on its own.
 *
 * This exists because a sprite can look fine in isolation and wrong in the
 * world, and the reverse. Judging a hut from a screenshot of a village is
 * guesswork; judging it next to every other model at the same scale is not.
 *
 * Open with `?lab=1`.
 */

const CELL = 130;
const COLS = 7;

function label(text: string, x: number, y: number): Text {
  const node = new Text({
    text,
    style: new TextStyle({
      fontFamily: 'ui-monospace, monospace',
      fontSize: 11,
      fill: '#8fa3b5',
    }),
  });
  node.position.set(x, y);
  return node;
}

/** A plant drawn exactly as the renderer draws it, so the lab cannot drift. */
function plantSprite(
  species: 'grass' | 'bush' | 'tree' | 'stump' | 'food',
  food = 0.8,
  timber = 1,
): Graphics {
  const g = new Graphics();
  const outlineWidth = 0.05;
  if (species === 'tree' || species === 'stump') {
    const radius = 1.05 * (0.4 + 0.6 * timber);
    if (species === 'stump' || timber < 0.2) {
      g.circle(0, 0, radius).fill({ color: 0x6b4f2a }).stroke({ color: outlineOf(0x6b4f2a), width: outlineWidth });
    } else {
      const rim = 0x2f4a2c;
      const crown = 0x4a6b3a;
      g.circle(0, 0, radius).fill({ color: rim }).stroke({ color: outlineOf(rim), width: outlineWidth });
      g.circle(-radius * 0.14, -radius * 0.14, radius * 0.68).fill({ color: crown });
    }
  } else if (species === 'bush') {
    const size = 0.8;
    g.circle(0, 0, size).fill({ color: 0x3f5c30 }).stroke({ color: outlineOf(0x3f5c30), width: outlineWidth });
  } else if (species === 'food') {
    // Matches the renderer: a heap of berries, not a square.
    const berries: Array<[number, number, number]> = [
      [-0.45, 0.18, 1],
      [0.42, -0.08, 1],
      [0.02, 0.46, 0.92],
      [-0.12, -0.28, 1.05],
    ];
    for (const [ox, oy, s2] of berries) {
      g.circle(ox, oy, 0.4 * s2).fill({ color: 0xc8552a }).stroke({ color: outlineOf(0xc8552a), width: outlineWidth });
      g.circle(ox - 0.12, oy - 0.12, 0.17 * s2).fill({ color: 0xe8823f });
    }
  } else {
    g.circle(0, 0, 0.3).fill({ color: 0x5a7a44, alpha: 0.55 + food * 0.3 });
  }
  return g;
}

export function SpriteLab(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const app = new Application();
    let disposed = false;
    const root = new Container();

    const humans: Array<{ sprite: HumanoidSprite; action: number }> = [];
    const structures: Array<{ sprite: StructureSprite; progress: number; complete: boolean }> = [];
    const animated: Array<(t: number) => void> = [];

    void app
      .init({ background: '#0b1118', width: host.clientWidth, height: host.clientHeight, antialias: true })
      .then(() => {
        if (disposed) {
          app.destroy(true);
          return;
        }
        host.appendChild(app.canvas);
        app.stage.addChild(root);

        let row = 0;
        let col = 0;
        const place = (title: string, node: Container): void => {
          const x = 90 + col * CELL;
          const y = 70 + row * CELL;
          node.position.set(x, y);
          root.addChild(node);
          const text = label(title, x - 54, y + 52);
          root.addChild(text);
          col++;
          if (col >= COLS) {
            col = 0;
            row++;
          }
        };

        // --- every humanoid action, side by side -----------------------------
        for (let action = 0; action < MOTOR_COUNT; action++) {
          const sprite = new HumanoidSprite({ baseHeight: 1 });
          sprite.scale.set(46);
          sprite.setAppearance(0.08, 0.45, 0.58);
          place(MOTOR_NAMES[action], sprite);
          humans.push({ sprite, action });
        }

        // --- predators --------------------------------------------------------
        const predator = new HumanoidSprite({ baseHeight: 1, predator: true });
        predator.scale.set(46);
        predator.setAppearance(0.02, 0.3, 0.34);
        place('predator', predator);
        humans.push({ sprite: predator, action: 0 });

        // --- structures, three states ----------------------------------------
        const states: Array<[string, number, boolean]> = [
          ['hut: staked', 0.05, false],
          ['hut: framed', 0.5, false],
          ['hut: finished', 1, true],
        ];
        for (const [name, progress, complete] of states) {
          const hut = new StructureSprite(0);
          hut.update(progress, complete, 0);
          // Wrapped in a container because StructureSprite.update() sets its own
          // scale — a finished hut is drawn a touch larger — so an outer scale
          // applied directly to the sprite is overwritten on the next update.
          const wrapper = new Container();
          wrapper.addChild(hut);
          wrapper.scale.set(17);
          place(name, wrapper);
          structures.push({ sprite: hut, progress, complete });
        }

        // --- plants -----------------------------------------------------------
        const plants: Array<[string, ReturnType<typeof plantSprite>]> = [
          ['grass', plantSprite('grass')],
          ['bush', plantSprite('bush')],
          ['tree: full', plantSprite('tree', 0.8, 1)],
          ['tree: half', plantSprite('tree', 0.8, 0.5)],
          ['stump', plantSprite('stump', 0, 0)],
          ['food pile', plantSprite('food')],
        ];
        for (const [name, graphic] of plants) {
          graphic.scale.set(46);
          place(name, graphic);
        }

        // --- cultivation ------------------------------------------------------
        const cult: Array<[string, number, boolean, number]> = [
          ['field: fallow', CULTIVATION_COLORS.fallow, false, 0.6],
          ['field: growing', CULTIVATION_COLORS.growing, false, 0.6],
          ['field: ripe', CULTIVATION_COLORS.ripe, false, 0.6],
          ['canal: dry', CULTIVATION_COLORS.canalDry, false, 0],
          ['canal: dug', CULTIVATION_COLORS.canalDug, false, 0],
          ['canal: flowing', CULTIVATION_COLORS.canalFlowing, false, 0],
        ];
        for (const [name, color, , ] of cult) {
          const size = name.startsWith('canal') ? 1.6 : 2.8;
          const g = new Graphics();
          g.roundRect(-size / 2, -size / 2, size, size, 0.3)
            .fill({ color })
            .stroke({ color: outlineOf(color, 0.45), width: 0.05 });
          g.scale.set(22);
          place(name, g);
        }

        // --- shared shadow reference -----------------------------------------
        const shadow = new Graphics();
        shadow.ellipse(0, 0, 1, 0.5).fill({ color: 0x0a0f14, alpha: 0.3 });
        shadow.scale.set(30);
        place('shadow', shadow);

        // Animate the humanoids so a still frame cannot hide a broken pose.
        animated.push(() => {
          for (const { sprite, action } of humans) {
            // Locomotion actions get a real speed so the stride is visible, and
            // each action gets its own time step so the seventeen poses do not
            // all freeze at the same point in the cycle.
            const walking = action === 0 || action === 1 || action === 2 || action === 3 || action === 4;
            sprite.update(0.016 * (1 + action * 0.23), action, walking ? 1.5 : 0, 0, 0, 0, 1, 0.08, 0.45, 0.58);
          }
          // Each hut keeps its own state; the first version fed a private field
          // back in as the progress and every hut rendered as "framed".
          for (const hut of structures) hut.sprite.update(hut.progress, hut.complete, 0);
        });
      });

    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const t = performance.now() / 1000;
      for (const fn of animated) fn(t);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      app.destroy(true, { children: true });
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0b1118' }}>
      <div style={{ padding: '10px 14px', color: '#c7d6e2', font: '13px ui-monospace, monospace' }}>
        Sprite lab — every model, at one scale. Structures x26, humans x46, plants x46.
      </div>
      <div ref={hostRef} style={{ position: 'absolute', inset: '40px 0 0 0' }} />
    </div>
  );
}
