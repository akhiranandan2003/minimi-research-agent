import { useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

function getOrCreateConversationId() {
  const key = 'minimi-conversation-id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export default function App() {
  const [conversationId] = useState(getOrCreateConversationId);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Checking API…');
  const bottomRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/api/conversations/${conversationId}/messages`).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json();
      setMessages(data.messages || []);
    }).catch(() => {});
  }, [conversationId]);

  useEffect(() => {
    fetch(`${API}/api/health`).then(async (response) => {
      const data = await response.json();
      setStatus(data.status === 'ok' ? 'Ready' : `Add server keys: ${(data.missing || []).join(', ')}`);
    }).catch(() => setStatus('API unavailable — start the server with npm run dev'));
  }, []);

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, busy]);

  async function sendMessage(event) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft('');
    setMessages((current) => [...current, { role: 'user', content: message }]);
    setBusy(true);
    try {
      const response = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      setMessages((current) => [...current, { role: 'assistant', content: data.answer, sources: data.sources || [] }]);
    } catch (error) {
      setMessages((current) => [...current, { role: 'assistant', content: `I couldn't complete that request: ${error.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  function startNewChat() {
    localStorage.removeItem('minimi-conversation-id');
    window.location.reload();
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark">M</div>
        <div><div className="brand-name">minimi</div><div className="brand-subtitle">Research agent</div></div>
        <div className="topbar-right"><span className="status-dot" />{status}<button className="new-chat" onClick={startNewChat}>New chat</button></div>
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
        <div className="composer-bottom"><span>Enter to send · Shift + Enter for a new line</span><button type="submit" disabled={busy || !draft.trim()}>{busy ? 'Working…' : 'Send ↑'}</button></div>
      </form>
      <footer>Minimi can make mistakes. Verify important information with the linked sources.</footer>
    </main>
  );
}
