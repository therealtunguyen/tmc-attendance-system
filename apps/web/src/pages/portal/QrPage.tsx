import { useEffect, useState } from 'react';
import { clearSession, loadSession, signOut, type Session } from '../../session';
import { fetchLiveQr, LiveQrController, qrCacheFor, type QrView } from './live-qr';
import { QrScreen } from './QrScreen';
import { SignInForm } from './SignInForm';

function LiveQrPanel({ session, onEnd }: { session: Session; onEnd: () => void }) {
  const [view, setView] = useState<QrView>({ kind: 'loading' });

  useEffect(() => {
    const live = new LiveQrController(
      () => fetchLiveQr(session.token),
      qrCacheFor(session.token),
      setView,
    );
    const wake = () => {
      if (document.visibilityState === 'visible') void live.refresh();
    };
    const online = () => void live.refresh();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', online);
    live.start();
    return () => {
      live.stop();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', online);
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
      <QrScreen view={view} />
      <button type="button" onClick={leave}>
        Sign out
      </button>
    </>
  );
}

/** The live QR (FR-1.2, FR-1.3); the email links here. */
export function QrPage() {
  const [session, setSession] = useState(() => loadSession());
  const end = () => {
    clearSession();
    setSession(null);
  };
  if (!session) return <SignInForm onSignedIn={setSession} />;
  return <LiveQrPanel session={session} onEnd={end} />;
}
