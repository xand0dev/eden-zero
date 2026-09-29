import { useEffect, useState } from 'react';
import { useSim } from '../../ui/sim';
import { game, useGameUi } from '../../ui/game';
import { updateProfile } from '../../meta/profile';

/**
 * First dawn — the first hour, taught by doing.
 *
 * No wall of text: each card asks for one thing and moves on when the observer
 * has done it. It teaches the three ideas the whole game rests on — nobody is
 * scripted, you can look inside any brain, and you act through a budget of
 * favour rather than by command.
 */

interface Step {
  title: string;
  text: string;
  done(ctx: { selected: boolean; brainOpen: boolean; foodPlaced: boolean; fast: boolean; journal: boolean }): boolean;
}

const STEPS: Step[] = [
  {
    title: 'Nobody writes what they do',
    text: 'Eight people have just woken. There is no script in this world: every step they take is the output of a spiking brain. Click one of them.',
    done: (c) => c.selected,
  },
  {
    title: 'Look inside',
    text: 'The panel on the right is their body and their brain. Press “expand” on the brain to see the spikes that are firing right now, and what they are for.',
    done: (c) => c.brainOpen,
  },
  {
    title: 'You act through favour',
    text: 'Close the brain (Esc). Pick “Spawn food” in the tools and place it near someone. It costs favour — which grows as the world does: births, generations, discoveries.',
    done: (c) => c.foodPlaced,
  },
  {
    title: 'Let time run',
    text: 'Press 2 for ×5. A year is eight days; the first winter will test them. When something important happens, time slows by itself.',
    done: (c) => c.fast,
  },
  {
    title: 'Keep the history',
    text: 'Press C for the chronicle and A for the atlas of behaviours. Everything in the atlas was discovered, not written. Your goal: see this camp become a village.',
    done: (c) => c.journal,
  },
];

export function FirstDawn(): JSX.Element | null {
  const state = useSim();
  const ui = useGameUi();
  const [step, setStep] = useState(0);
  const [brainOpen, setBrainOpen] = useState(false);
  const [foodPlaced, setFoodPlaced] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setBrainOpen(document.body.classList.contains('brain-open')), 400);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (state.lastCommand?.ok && state.lastCommand.kind === 'spawnFood') setFoodPlaced(true);
  }, [state.lastCommand]);

  const active = state.config.mode === 'campaign' && !ui.profile.tutorialDone && step < STEPS.length;
  const ctx = {
    selected: state.selectedId !== null,
    brainOpen,
    foodPlaced,
    fast: !state.paused && state.speed >= 5,
    journal: ui.journal !== null,
  };
  const current = STEPS[step];
  const complete = active && current.done(ctx);

  useEffect(() => {
    if (!complete) return undefined;
    const id = window.setTimeout(() => {
      if (step + 1 >= STEPS.length) {
        updateProfile((p) => {
          p.tutorialDone = true;
        });
        game.refreshProfile();
      }
      setStep(step + 1);
    }, 900);
    return () => window.clearTimeout(id);
  }, [complete, step]);

  if (!active) return null;
  return (
    <div className={`first-dawn glass ${complete ? 'done' : ''}`}>
      <div className="first-dawn-head">
        <span className="kicker">
          First dawn · {step + 1}/{STEPS.length}
        </span>
        <button
          className="link"
          onClick={() => {
            updateProfile((p) => {
              p.tutorialDone = true;
            });
            game.refreshProfile();
          }}
        >
          skip
        </button>
      </div>
      <b>{current.title}</b>
      <p>{current.text}</p>
    </div>
  );
}
