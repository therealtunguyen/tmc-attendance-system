import { useEffect, useState } from 'react';
import { clearSession, loadSession, signOut, type Session } from '../../session';
import { fetchHistory } from './history';
import { HistoryScreen, type HistoryView } from './HistoryScreen';
import { SignInForm } from './SignInForm';

function HistoryPanel({ session, onEnd }: { session: Session; onEnd: () => void }) {
  const [view, setView] = useState<HistoryView>({ kind: 'loading' });

  useEffect(() => {
    let current = true;
    void fetchHistory(session.token).then((result) => {
      if (current) setView(result);
    });
    return () => {
      current = false;
    };
  }, [session]);

  useEffect(() => {
    if (view.kind === 'signed-out') onEnd();
  }, [view, onEnd]);

  const leave = () => {
    void signOut(session);
    onEnd();
  };

  return (
    <>
      <HistoryScreen view={view} />
      <button type="button" onClick={leave}>
        Sign out
      </button>
    </>
  );
}

/** Own profile and attendance history (FR-1.6, UC-3). */
export function HistoryPage() {
  const [session, setSession] = useState(() => loadSession());
  const end = () => {
    clearSession();
    setSession(null);
  };
  if (!session) {
    return <SignInForm onSignedIn={setSession} heading="Sign in to see your attendance" />;
  }
  return <HistoryPanel session={session} onEnd={end} />;
}
