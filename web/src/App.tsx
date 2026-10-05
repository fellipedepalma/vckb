import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, onUnauthorized, paths } from './api';
import { applyMove } from './board-move';
import { announceInDndRegion, Board, focusCard } from './components/Board';
import { Login } from './components/Login';
import { TaskDialog } from './components/TaskDialog';
import { BoardSkeleton, describeError, DismissibleAlert, ErrorPanel, Notice } from './components/States';
import { TopBar } from './components/TopBar';
import { useBoard, useDebounced, useLiveEvents, useProjectRoute, useProjects } from './hooks';
import { strings } from './strings';
import type { TaskPatch } from './task-form';
import type { BoardSnapshot, Task } from './types';

type Session = { state: 'checking' } | { state: 'signedOut' } | { state: 'signedIn' } | { state: 'error'; error: unknown };

export function App() {
  const [session, setSession] = useState<Session>({ state: 'checking' });

  const check = useCallback(async () => {
    setSession({ state: 'checking' });
    try {
      await api.get(paths.session, { quiet401: true });
      setSession({ state: 'signedIn' });
    } catch (error) {
      // 421: the sign-in screen explains VCKB_ALLOWED_HOSTS when the user tries.
      if (error instanceof ApiError && (error.status === 401 || error.status === 421)) setSession({ state: 'signedOut' });
      else setSession({ state: 'error', error });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => onUnauthorized(() => setSession({ state: 'signedOut' })), []);

  if (session.state === 'checking') {
    return (
      <p role="status" className="px-6 py-10 text-muted">
        {strings.session.checking}
      </p>
    );
  }
  if (session.state === 'error') return <ErrorPanel title={strings.errors.generic} error={session.error} onRetry={check} />;
  if (session.state === 'signedOut') return <Login onSignedIn={() => setSession({ state: 'signedIn' })} />;
  return <Workspace onSignedOut={() => setSession({ state: 'signedOut' })} />;
}

function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const [projects, reloadProjects] = useProjects();
  const [routeSlug, go] = useProjectRoute();
  const list = projects.status === 'ready' ? projects.data : (projects.data ?? []);
  const slug = routeSlug ?? list[0]?.slug ?? null;
  const [board, reloadBoard] = useBoard(slug);

  // /  ->  /p/<first project>
  useEffect(() => {
    if (!routeSlug && slug) go(slug, true);
  }, [routeSlug, slug, go]);

  useEffect(() => {
    const name = list.find((p) => p.slug === slug)?.name;
    document.title = strings.app.documentTitle(name);
  }, [list, slug]);

  // Live updates: refetch the affected board (debounced: an agent often writes several files at once).
  const refreshBoard = useDebounced(() => void reloadBoard(), 250);
  const refreshProjects = useDebounced(() => void reloadProjects(), 250);
  const known = useRef(new Set<string>());
  known.current = new Set(list.map((p) => p.slug));
  // While a card is being dragged, live refetches wait: applying them mid-drag would move cards
  // under the pointer. They run right after the drop.
  const dragging = useRef(false);
  const deferred = useRef(false);
  const refreshBoardLive = useCallback(() => {
    if (dragging.current) deferred.current = true;
    else refreshBoard();
  }, [refreshBoard]);
  const onDragStateChange = useCallback(
    (d: boolean) => {
      dragging.current = d;
      if (!d && deferred.current) {
        deferred.current = false;
        refreshBoard();
      }
    },
    [refreshBoard],
  );

  const live = useLiveEvents((project) => {
    if (project === slug) refreshBoardLive();
    if (!known.current.has(project)) refreshProjects();
  });

  // Events may have been missed while disconnected: resync when the stream comes back.
  const wasLive = useRef(false);
  useEffect(() => {
    if (live === 'live' && wasLive.current === false) {
      wasLive.current = true;
      return;
    }
    if (live === 'live') {
      refreshBoardLive();
      refreshProjects();
    }
    if (live === 'reconnecting') wasLive.current = true;
  }, [live, refreshBoardLive, refreshProjects]);

  // Moves are optimistic: `pending` is shown at once and kept until the server's state (refetched
  // after the last save) replaces it, so nothing flashes. Any failure rolls back to the server's state.
  //
  // Saves are queued per project: a move renumbers the other cards of its column (their files, and
  // so their etags, change), so each PATCH waits for the previous one and sends the newest etag known
  // for its card: from the ETag of an earlier save of that card, or from `renumbered` (id -> etag) in
  // the response of an earlier save of another card. Changes made by anyone else still get a 412. If a save fails, the moves
  // already queued are not sent and the board returns to the server's state; later moves start afresh.
  const [pending, setPending] = useState<BoardSnapshot | null>(null);
  const [moveNotice, setMoveNotice] = useState<string | null>(null);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const etags = useRef(new Map<string, string>());
  const inFlight = useRef(0);
  useEffect(() => {
    setPending(null);
    setMoveNotice(null);
    queue.current = Promise.resolve(true);
    etags.current.clear();
  }, [slug]);

  /**
   * Remembers the etags a save answered with: the saved card's (ETag header) and the other cards the
   * save renumbered (`renumbered`, keyed by task ID; etags are tracked by file because IDs can repeat
   * on a damaged board). Returns the ones that changed.
   */
  const recordEtags = (tasks: Task[], file: string, res: { data: { renumbered?: Record<string, string> } | null; etag?: string }) => {
    const fileOf = new Map(tasks.map((t) => [t.id, t.file]));
    const fresh = new Map<string, string>();
    for (const [id, etag] of Object.entries(res.data?.renumbered ?? {})) {
      const f = fileOf.get(id);
      if (f && typeof etag === 'string') fresh.set(f, etag);
    }
    if (res.etag) fresh.set(file, res.etag);
    for (const [f, etag] of fresh) etags.current.set(f, etag);
    return fresh;
  };

  /**
   * Saves an edit from the details dialog through the same queue as the moves, so it never overlaps a
   * move that is still being saved and always sends the newest etag we know for the card. Resolves
   * after the board was refetched (the card then shows the new data); rejects with the ApiError /
   * NetworkError, leaving the board as it is: the dialog shows the problem and keeps what was typed.
   */
  const saveEdit = async (task: Task, patch: TaskPatch, etag: string) => {
    if (!slug) throw new Error('no project');
    const base = pending ?? board.data;
    inFlight.current++;
    const save = queue.current.then(async () => {
      try {
        const res = await api.patch<{ renumbered?: Record<string, string> }>(paths.task(slug, task.id), patch, {
          ifMatch: etags.current.get(task.file) ?? etag,
        });
        recordEtags(base?.tasks ?? [], task.file, res);
        return { error: null };
      } catch (error) {
        etags.current.delete(task.file); // whatever we knew about this file is now doubtful
        return { error };
      }
    });
    queue.current = save.then(() => true); // a failed edit must not drop the moves queued after it
    const { error } = await save;
    if (--inFlight.current === 0) {
      if (!error) await reloadBoard();
      if (inFlight.current === 0) {
        setPending(null);
        etags.current.clear();
      }
    }
    if (error) throw error;
  };

  // The details dialog: which card is open, with the task as it was when it opened.
  const [editing, setEditing] = useState<Task | null>(null);
  useEffect(() => setEditing(null), [slug]);

  const onMove = async (file: string, status: string, position: number) => {
    const base = pending ?? board.data;
    const task = base?.tasks.find((t) => t.file === file);
    if (!base || !task || !slug) return;
    const next = applyMove(base.tasks, file, status, position);
    if (!next) return;
    setMoveNotice(null);
    setPending({ ...base, tasks: next });
    inFlight.current++;

    const save = queue.current.then(async (previousOk) => {
      if (!previousOk) return false; // an earlier queued move failed and was rolled back
      try {
        const res = await api.patch<{ renumbered?: Record<string, string> }>(paths.task(slug, task.id), { status, position }, {
          ifMatch: etags.current.get(file) ?? task.etag,
        });
        const fresh = recordEtags(base.tasks, file, res);
        if (fresh.size) setPending((p) => p && { ...p, tasks: p.tasks.map((t) => (fresh.has(t.file) ? { ...t, etag: fresh.get(t.file)! } : t)) });
        return true;
      } catch (err) {
        const conflict = err instanceof ApiError && err.status === 412;
        setMoveNotice(conflict ? strings.move.conflict(task.id) : strings.move.failed(task.id, describeError(err)));
        setPending(null);
        etags.current.clear();
        queue.current = Promise.resolve(true); // moves made after this failure are sent normally
        // Also for screen readers (dnd-kit's live region), and focus back on the card it rolled back.
        const saved = board.data?.tasks.find((t) => t.file === file)?.status ?? task.status;
        announceInDndRegion(strings.dnd.saveFailed(task.id, strings.board.columnName(saved)));
        focusCard(file);
        void reloadBoard();
        return false;
      }
    });
    queue.current = save;
    const ok = await save;
    if (--inFlight.current > 0) return;
    if (ok) await reloadBoard();
    if (inFlight.current === 0) {
      setPending(null);
      etags.current.clear();
    }
  };
  const shown = pending ?? board.data;

  const signOut = async () => {
    try {
      await api.post(paths.logout);
    } finally {
      onSignedOut();
    }
  };

  let content;
  if (projects.status === 'loading' && !projects.data) content = <BoardSkeleton />;
  else if (projects.status === 'error' && !projects.data)
    content = <ErrorPanel title={strings.board.loadError} error={projects.error} onRetry={reloadProjects} />;
  else if (!list.length) content = <Notice title={strings.projects.none}>{strings.projects.noneHint}</Notice>;
  else if (slug && !list.some((p) => p.slug === slug)) content = <Notice title={strings.projects.notFound(slug)} />;
  else if (shown)
    content = (
      <Board
        snapshot={shown}
        onMove={onMove}
        onDragStateChange={onDragStateChange}
        onOpen={(file) => setEditing(shown.tasks.find((t) => t.file === file) ?? null)}
      />
    );
  else if (board.status === 'error') content = <ErrorPanel title={strings.board.loadError} error={board.error} onRetry={reloadBoard} />;
  else content = <BoardSkeleton />;

  return (
    <div className="flex h-dvh flex-col">
      <TopBar projects={list} current={slug} onSelect={(s) => go(s)} live={live} onSignOut={signOut} />
      <main className="flex min-h-0 flex-1 flex-col">
        {board.status === 'error' && board.data && (
          <ErrorPanel title={strings.board.loadError} error={board.error} onRetry={reloadBoard} />
        )}
        {moveNotice && <DismissibleAlert message={moveNotice} onDismiss={() => setMoveNotice(null)} />}
        {content}
      </main>
      {editing && slug && shown && (
        <TaskDialog
          key={editing.file}
          task={editing}
          slug={slug}
          columns={shown.project.columns}
          onSave={(patch, etag) => saveEdit(editing, patch, etag)}
          onReload={async () => (await api.get<Task>(paths.task(slug, editing.id))).data}
          onClose={() => {
            setEditing(null);
            focusCard(editing.file);
          }}
        />
      )}
    </div>
  );
}
