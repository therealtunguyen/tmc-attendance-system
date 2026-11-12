import { useState, type FormEvent, type ReactNode } from 'react';
import { passMfa, saveSession, signIn, type Session, type SignIn } from '../../session';

/** Stays on the page it was opened from, so the link in the email lands on the QR (FR-1.3). */
export function SignInForm({
  onSignedIn,
  heading = 'Sign in to see your QR code',
  translate = (text) => text,
}: {
  onSignedIn: (session: Session) => void;
  heading?: string;
  translate?: (text: string) => ReactNode;
}) {
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const finish = (result: SignIn) => {
    if (result.kind === 'signed-in') {
      saveSession(result.session);
      return onSignedIn(result.session);
    }
    if (result.kind === 'mfa') {
      setError('');
      setPassword('');
      return setPendingToken(result.pendingToken);
    }
    if (result.restart) {
      setPendingToken(null);
      setCode('');
    }
    setError(result.message);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    finish(await (pendingToken ? passMfa(pendingToken, code) : signIn(username, password)));
    setBusy(false);
  };

  const field = { display: 'block', width: '100%', padding: 8, marginBottom: 12 };

  return (
    <form onSubmit={(event) => void submit(event)} style={{ maxWidth: 320 }}>
      <h2>{translate(heading)}</h2>
      {pendingToken ? (
        <label>
          {translate('Authenticator code')}
          <input
            style={field}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
        </label>
      ) : (
        <>
          <label>
            {translate('Username')}
            <input
              style={field}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            {translate('Password')}
            <input
              style={field}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
        </>
      )}
      {error && <p role="alert">{translate(error)}</p>}
      <button type="submit" disabled={busy}>
        {translate('Continue')}
      </button>
    </form>
  );
}
