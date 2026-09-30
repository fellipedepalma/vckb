import type { LiveStatus } from '../hooks';
import { strings } from '../strings';
import type { Project } from '../types';

const LIVE: Record<LiveStatus, { text: string; hint: string; dot: string }> = {
  connecting: { text: strings.connection.connecting, hint: strings.connection.reconnectingHint, dot: 'bg-muted' },
  live: { text: strings.connection.live, hint: strings.connection.liveHint, dot: 'bg-mint' },
  reconnecting: { text: strings.connection.reconnecting, hint: strings.connection.reconnectingHint, dot: 'bg-steel' },
};

export function TopBar(props: {
  projects: Project[];
  current: string | null;
  onSelect: (slug: string) => void;
  live: LiveStatus;
  onSignOut: () => void;
}) {
  const live = LIVE[props.live];
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line/60 px-4 py-2.5 sm:px-6">
      <span className="text-lg font-bold tracking-tight" title={strings.app.fullName}>
        {strings.app.name}
      </span>

      <nav aria-label={strings.projects.navLabel} className="order-last -mx-1 w-full overflow-x-auto sm:order-none sm:w-auto sm:flex-1">
        <ul className="flex gap-1 px-1">
          {props.projects.map((p) => {
            const active = p.slug === props.current;
            return (
              <li key={p.slug}>
                <a
                  href={`/p/${encodeURIComponent(p.slug)}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    props.onSelect(p.slug);
                  }}
                  className={`block whitespace-nowrap rounded-md px-3 py-1.5 text-[15px] transition-colors ${
                    active ? 'bg-card font-semibold text-ink' : 'text-muted hover:bg-lane hover:text-ink'
                  }`}
                >
                  {p.name}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="ml-auto flex items-center gap-4 sm:ml-0">
        <p className="flex items-center gap-2 text-sm text-muted" title={live.hint} role="status" aria-live="polite">
          <span aria-hidden="true" className={`size-2 rounded-full ${live.dot}`} />
          <span>{live.text}</span>
          <span className="sr-only">{live.hint}</span>
        </p>
        <button
          type="button"
          onClick={props.onSignOut}
          className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-lane hover:text-ink"
        >
          {strings.session.signOut}
        </button>
      </div>
    </header>
  );
}
