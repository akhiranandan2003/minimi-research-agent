import { useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

function getOrCreateConversationId(userId) {
  const key = `minimi-conversation-id:${userId}`;
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Checking API…');
  const bottomRef = useRef(null);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return undefined;
    }

    let active = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setAuthError('Could not restore your session. Please sign in again.');
      setSession(data.session);
      setAuthReady(true);
    }).catch(() => {
      if (active) {
        setAuthError('Could not connect to Supabase Auth.');
        setAuthReady(true);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user?.id) {
      setConversationId(null);
      setMessages([]);
      return;
    }
    setMessages([]);
    setConversationId(getOrCreateConversationId(session.user.id));
  }, [session?.user?.id]);

  useEffect(() => {
    if (!conversationId || !session?.access_token) return undefined;
    let active = true;
    fetch(`${API}/api/conversations/${conversationId}/messages`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (response) => {
      if (response.status === 401) {
        await supabase.auth.signOut();
        return null;
      }
      if (!response.ok) throw new Error('Could not load this conversation.');
      return response.json();
    }).then((data) => {
      if (active && data) setMessages(data.messages || []);
    }).catch(() => {
      if (active) setStatus('History unavailable — check your API connection');
    });
    return () => { active = false; };
  }, [conversationId, session?.access_token]);

  useEffect(() => {
    fetch(`${API}/api/health`).then(async (response) => {
      const data = await response.json();
      setStatus(data.status === 'ok' ? 'Ready' : `Add server keys: ${(data.missing || []).join(', ')}`);
    }).catch(() => setStatus('API unavailable — start the server with npm run dev'));
  }, []);

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, busy]);

  async function submitAuth(event) {
    event.preventDefault();
    if (!supabase || authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    setAuthMessage('');
    try {
      const result = authMode === 'signup'
        ? await supabase.auth.signUp({ email: email.trim(), password })
        : await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw result.error;
      if (authMode === 'signup' && !result.data.session) {
        setAuthMessage('Check your email to confirm your account, then sign in.');
      } else {
        setAuthMessage('');
      }
    } catch (error) {
      setAuthError(error.message || 'Authentication failed. Please try again.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setMessages([]);
    setDraft('');
  }

  async function sendMessage(event) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy || !conversationId || !session?.access_token) return;
    setDraft('');
    setMessages((current) => [...current, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const response = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ conversationId, message }),
      });
      const data = await response.json();
      if (response.status === 401) {
        await supabase.auth.signOut();
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Request failed');
      setMessages((current) => [...current, { role: 'assistant', content: data.answer, sources: data.sources || [] }]);
    } catch (error) {
      setMessages((current) => [...current, { role: 'assistant', content: `I couldn't complete that request: ${error.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  function startNewChat() {
    if (!session?.user?.id) return;
    const nextId = crypto.randomUUID();
    localStorage.setItem(`minimi-conversation-id:${session.user.id}`, nextId);
    setMessages([]);
    setConversationId(nextId);
  }

  if (!authReady) {
    return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">M</div><h1>Loading Minimi…</h1></section></main>;
  }

  if (!supabase) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand-mark">M</div>
          <h1>Connect Minimi to Supabase</h1>
          <p>Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your root .env file, then restart the Vite server.</p>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand-mark">M</div>
          <div className="auth-eyebrow">YOUR RESEARCH COMPANION</div>
          <h1>{authMode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>
          <p>Sign in to keep your research conversations private and available across sessions.</p>
          <form className="auth-form" onSubmit={submitAuth}>
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <label htmlFor="auth-password">Password</label>
            <input id="auth-password" type="password" autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'} minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
            {authError && <div className="auth-error" role="alert">{authError}</div>}
            {authMessage && <div className="auth-message" role="status">{authMessage}</div>}
            <button type="submit" disabled={authBusy}>{authBusy ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}</button>
          </form>
          <button className="auth-switch" type="button" onClick={() => { setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); setAuthError(''); setAuthMessage(''); }}>
            {authMode === 'signin' ? 'New to Minimi? Create an account' : 'Already registered? Sign in'}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark">M</div>
        <div><div className="brand-name">minimi</div><div className="brand-subtitle">Research agent</div></div>
        <div className="topbar-right"><span className="status-dot" />{status}<button className="new-chat" onClick={startNewChat}>New chat</button><button className="new-chat" onClick={signOut}>Sign out</button></div>
      </header>

      <section className="chat-area">
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="eyebrow">YOUR RESEARCH COMPANION</div>
            <h1>What would you like<br />to figure out?</h1>
            <p>Ask a question, explore a topic, or compare how something has changed over time.</p>
            <div className="suggestions">
              {['What changed in the latest Node.js releases?', 'Compare React and Vue for a new project', 'What did I tell you earlier in this chat?'].map((item) => <button key={item} onClick={() => setDraft(item)}>{item}<span>↗</span></button>)}
            </div>
          </div>
        ) : (
          <div className="message-list">
            {messages.map((item, index) => <article className={`message ${item.role}`} key={index}>
              <div className="avatar">{item.role === 'user' ? 'You' : 'M'}</div>
              <div className="message-content"><div className="role-label">{item.role === 'user' ? 'YOU' : 'MINIMI'}</div><div className="message-text">{item.content}</div>
                {item.sources?.length > 0 && <div className="sources"><div className="sources-title">SOURCES</div>{item.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">[{source.citation}] {source.title} ↗</a>)}</div>}
              </div>
            </article>)}
            {busy && <div className="thinking"><span /> Minimi is researching…</div>}
            <div ref={bottomRef} />
          </div>
        )}
      </section>

      <form className="composer" onSubmit={sendMessage}>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(event); } }} placeholder="Ask Minimi anything…" rows="2" maxLength={6000} />
        <div className="composer-bottom"><span>Enter to send · Shift + Enter for a new line</span><button type="submit" disabled={busy || !draft.trim() || !conversationId}>{busy ? 'Working…' : 'Send ↑'}</button></div>
      </form>
      <footer>Minimi can make mistakes. Verify important information with the linked sources.</footer>
    </main>
  );
}
