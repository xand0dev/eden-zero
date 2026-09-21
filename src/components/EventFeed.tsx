import { useEffect, useRef } from 'react';
import { sim, useSim, formatSimTime } from '../ui/sim';

/**
 * World event timeline.
 *
 * Events that reference entities are clickable and select them, which turns the
 * feed into a navigation tool rather than a log.
 */
export function EventFeed(): JSX.Element {
  const state = useSim();
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Keep the newest event in view unless the user has scrolled up to read.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pinnedToBottom.current) return;
    container.scrollTop = container.scrollHeight;
  }, [state.events]);

  const events = state.events.slice(-140).reverse();

  return (
    <>
      <div className="panel" style={{ paddingBottom: 6 }}>
        <div className="panel-header" style={{ marginBottom: 0 }}>
          <h3>World events</h3>
          <span className="badge">{state.events.length}</span>
        </div>
      </div>
      <div
        className="events"
        ref={containerRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        {events.length === 0 ? (
          <div className="muted">Nothing has happened yet.</div>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className={`event k-${event.kind}`}
              onClick={() => {
                if (event.entityIds.length > 0) sim.select(event.entityIds[0]);
              }}
            >
              <span className="time">{formatSimTime(event.simTime)}</span>
              <span className="text">{event.text}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
