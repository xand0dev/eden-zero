import { useEffect, useRef } from 'react';
import { generateTerrain } from '../simulation/environment/terrain';
import { terrainParamsFor } from '../simulation/game/biomes';
import { WORLD_H, WORLD_W } from '../shared/constants';
import { paintTerrain } from '../render/terrain';

/**
 * The island a seed will produce, painted behind the Genesis screen.
 *
 * Same generator and same painter as the world itself, at a lower resolution,
 * so choosing a seed is choosing a place you can already see. Repainting is
 * debounced: typing a seed should not stall on every keystroke.
 */
export function IslandPreview({ seed, biome = 'valley' }: { seed: string; biome?: string }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const element = host.current;
      if (!element) return;
      const canvas = paintTerrain(generateTerrain(seed || 'eden', WORLD_W, WORLD_H, terrainParamsFor(biome)), 6);
      canvas.className = 'island-canvas';
      const previous = element.querySelector('canvas');
      element.appendChild(canvas);
      // Crossfade the new island in over the old one.
      requestAnimationFrame(() => canvas.classList.add('shown'));
      if (previous) window.setTimeout(() => previous.remove(), 700);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [seed, biome]);

  return <div className="island-preview" ref={host} aria-hidden="true" />;
}
