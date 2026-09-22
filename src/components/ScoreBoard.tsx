import { useSim } from '../ui/sim';
import type { HouseStats } from '../shared/types';

export function ScoreBoard(): JSX.Element | null {
  const state = useSim();
  const match = state.match;
  if (!match || !match.active) return null;

  const elapsed = Math.max(0, match.durationSeconds - match.elapsedSeconds);
  const minutes = Math.floor(elapsed / 60);
  const seconds = Math.floor(elapsed % 60);
  const timeLeft = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  const [house0, house1] = match.houses;
  const winner = match.ended ? match.winner : null;

  return (
    <div className="scoreboard">
      <div className="scoreboard-header">
        <span className="scoreboard-title">Match</span>
        <span className="scoreboard-time" data-low={elapsed <= 30 ? 'true' : undefined}>
          {match.ended ? 'ENDED' : timeLeft}
        </span>
      </div>
      <div className="scoreboard-row">
        <HouseRow
          name="House 0"
          hue={30}
          stats={house0}
          winner={winner === 0}
        />
        <HouseRow
          name="House 1"
          hue={210}
          stats={house1}
          winner={winner === 1}
        />
      </div>
    </div>
  );
}

function HouseRow({
  name,
  hue,
  stats,
  winner,
}: {
  name: string;
  hue: number;
  stats: HouseStats | undefined;
  winner: boolean;
}): JSX.Element {
  const s = stats ?? { population: 0, females: 0, males: 0, children: 0, deepestGeneration: 0, score: 0 };
  return (
    <div className={`scoreboard-house ${winner ? 'winner' : ''}`}>
      <div className="scoreboard-house-name" style={{ color: `hsl(${hue}, 70%, 65%)` }}>
        {name}
        {winner && <span className="scoreboard-crown"> 👑</span>}
      </div>
      <div className="scoreboard-house-stats">
        <span title="population">{s.population}</span>
        <span title="females / males">♀{s.females} ♂{s.males}</span>
        <span title="deepest generation">gen {s.deepestGeneration}</span>
      </div>
      <div className="scoreboard-house-score">{s.score}</div>
    </div>
  );
}
