import './App.css'
import { useRef, useState } from 'react'

type TabKey = 'chat' | 'rag';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';
const ML_BASE_URL = import.meta.env.VITE_ML_BASE_URL ?? 'http://localhost:8001';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
};

function LoginForm(props: { onLoginSuccess: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Temporary login-less mode: do not call API.
    // We simply store the email locally and let the backend
    // use its own DEV_DEFAULT_USER_EMAIL / auto-create logic.
    const effectiveEmail = email || 'test@example.com';
    if (!effectiveEmail) {
      setError('Please enter your work email.');
      setLoading(false);
      return;
    }

    props.onLoginSuccess(effectiveEmail);
    setLoading(false);
  };

  return (
    <div className="auth-card">
      <h2>Sign in to AuditAI</h2>
      <p className="auth-subtitle">
        This screen is for RTO staff. Please use your work email and password.
      </p>
      <form onSubmit={handleSubmit} className="auth-form">
        <label className="auth-label">
          Work email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="auth-input"
            placeholder="you@example.com"
            required
          />
        </label>
        <label className="auth-label">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="auth-input"
            placeholder="Enter your password"
            required
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="primary-button" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function ChatTab(props: { token: string | null }) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<'openai' | 'gemini'>('openai');
  const [model, setModel] = useState<string>('gpt-4o-mini');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const ensureSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/chat/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(props.token ? { Authorization: `Bearer ${props.token}` } : {}),
        },
        body: JSON.stringify({ user_email: 'test@example.com' }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Failed to create session (${res.status})`);
      }
      const data = await res.json();
      const sid = data.session_id ?? data.id;
      setSessionId(sid);
      return sid;
    } catch (err: any) {
      setError(err.message ?? 'Failed to create session');
      return null;
    }
  };

  const handleUploadClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setUploading(true);

    try {
      const email = props.token || 'test@example.com';
      const url = `${API_BASE_URL}/api/v1/documents/upload?email=${encodeURIComponent(
        email,
      )}`;

      // Ensure session exists before uploading
      const sid = await ensureSession();
      if (!sid) {
        throw new Error('Failed to create session for document upload');
      }

      const formData = new FormData();
      formData.append('file', file);
      // Use a valid backend enum value for DocumentType (see DocumentType in backend)
      // "policy" is a safe default for most compliance documents.
      formData.append('document_type', 'policy');
      formData.append('user_email', email);
      // Link document to current chat session
      formData.append('analysis_id', sid);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...(props.token ? { Authorization: `Bearer ${props.token}` } : {}),
        },
        body: formData,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(text || `Document upload failed (${res.status})`);
      }

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `I have received "${file.name}". You can ask me to check this document for compliance or analyze it.`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (err: any) {
      setError(
        'Sorry, I could not upload your document. Please try again or check your connection.',
      );
    } finally {
      setUploading(false);
      if (e.target) {
        e.target.value = '';
      }
    }
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    setError(null);
    setLoading(true);

    const newUserMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, newUserMessage]);
    const textToSend = input;
    setInput('');

    const sid = await ensureSession();
    if (!sid) {
      setLoading(false);
      return;
    }

    try {
      // Chat API expects analysis_id in the URL path
      const url = `${API_BASE_URL}/api/v1/chat/message/stream/${sid}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(props.token ? { Authorization: `Bearer ${props.token}` } : {}),
          'X-LLM-Provider': provider,
          'X-LLM-Model': model,
        },
        body: JSON.stringify({
          message: textToSend,
        }),
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
        throw new Error(text || `Chat request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let assistantId = crypto.randomUUID();
      let assistantContent = '';

      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
        },
      ]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        // Very simple SSE parser: lines starting with "data:"
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            const delta = json.delta ?? json.content ?? '';
            if (typeof delta === 'string' && delta.length > 0) {
              assistantContent += delta;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: assistantContent } : m,
                ),
              );
            }
          } catch {
            // If not JSON, append raw text
            assistantContent += payload;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: assistantContent } : m,
              ),
            );
          }
        }
      }
    } catch (err: any) {
      setError(err.message ?? 'Chat request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Chat</h2>
        <p>
          Ask anything about RTO and ASQA compliance. You can also upload
          documents for review directly here.
        </p>
        <div className="model-row">
          <label className="auth-label inline">
            Provider
            <select
              className="auth-input"
              value={provider}
              onChange={(e) => setProvider(e.target.value as 'openai' | 'gemini')}
            >
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>
          <label className="auth-label inline">
            Model
            <input
              className="auth-input"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g., gpt-4o-mini or gemini-2.0-flash"
            />
          </label>
        </div>
      </div>
      <div className="chat-window">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>
              Start by sending a message. The response will come from the API via
              SSE streaming.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-message chat-message-${m.role}`}>
            <div className="chat-message-role">
              {m.role === 'user' ? 'You' : 'Assistant'}
            </div>
            {m.role === 'assistant'
              ? (() => {
                  // Try different formats for Sources marker
                  const markers = [
                    '\n\nSources:\n',  // Preferred format with double newline
                    '\nSources:\n',    // Single newline
                    'Sources:\n',      // No newline before
                    '\n\nSources:',    // Without trailing newline
                    '\nSources:',      // Single newline without trailing newline
                    ' Sources:',       // Space before (from orchestrator)
                  ];
                  
                  let idx = -1;
                  let foundMarker = '';
                  for (const marker of markers) {
                    idx = m.content.indexOf(marker);
                    if (idx !== -1) {
                      foundMarker = marker;
                      break;
                    }
                  }
                  
                  if (idx === -1) {
                    return (
                      <div className="chat-message-content">{m.content}</div>
                    );
                  }
                  
                  const mainText = m.content.slice(0, idx).trim();
                  const sourcesText = m.content.slice(idx + foundMarker.length).trim();

  return (
    <>
                      <div className="chat-message-content">{mainText}</div>
                      <div className="chat-message-content chat-message-sources">
                        {sourcesText}
                      </div>
                    </>
                  );
                })()
              : (
                <div className="chat-message-content">{m.content}</div>
              )}
          </div>
        ))}
      </div>
      {error && <div className="panel-error">{error}</div>}
      <div className="chat-input-row">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask me anything about compliance…"
          className="chat-input"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <button
          type="button"
          className="secondary-button"
          onClick={handleUploadClick}
          disabled={uploading}
        >
          {uploading ? 'Uploading…' : 'Upload documents'}
        </button>
        <button
          className="primary-button"
          onClick={() => void handleSend()}
          disabled={loading || !input.trim()}
        >
          {loading ? 'Sending…' : 'Send'}
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
}

function RagAdminTab(props: { token: string | null }) {
  const [organizationId, setOrganizationId] = useState('');
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<'policy' | 'tas' | 'financial' | 'evidence' | 'report' | 'other'>('policy');
  const [documentText, setDocumentText] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [loadingFileUpload, setLoadingFileUpload] = useState(false);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPlainTextSection, setShowPlainTextSection] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setDocumentFile(file);
  };

  const handleUploadFileToRag = async () => {
    setError(null);
    setUploadResult(null);

    if (!documentFile) {
      setError('Please choose a document file to upload.');
      return;
    }

    setLoadingFileUpload(true);

    try {
      const email = props.token || 'test@example.com';
      const url = `${API_BASE_URL}/api/v1/documents/upload?email=${encodeURIComponent(
        email,
      )}`;

      const formData = new FormData();
      formData.append('file', documentFile);
      formData.append('document_type', documentType);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...(props.token ? { Authorization: `Bearer ${props.token}` } : {}),
        },
        body: formData,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(text || `Document upload failed (${res.status})`);
      }

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      if (data && data.id) {
        setDocumentId(data.id);
        setUploadResult(
          `Document uploaded and sent to RAG. ID: ${data.id}, type: ${data.type}, status: ${data.status}.`,
        );
      } else {
        setUploadResult(
          `Document uploaded and sent to RAG. Raw response: ${text}`,
        );
      }
    } catch (err: any) {
      setError(
        err.message ??
          'Sorry, I could not upload your document. Please try again or check your connection.',
      );
    } finally {
      setLoadingFileUpload(false);
    }
  };

  const handleStoreInRag = async () => {
    setError(null);
    setUploadResult(null);
    if (!documentText.trim()) {
      setError('Please provide document text to store in RAG.');
      return;
    }
    setLoadingUpload(true);
    const docId = documentId || `test-doc-${Date.now()}`;

    try {
      const payload: any = {
        document_id: docId,
        text: documentText,
        document_type: 'document',
        document_category: 'policy',
        metadata: {
          title: 'Manual RAG Test Document',
          source: 'frontend',
        },
      };
      if (organizationId.trim()) {
        payload.organization_id = organizationId.trim();
      }

      const res = await fetch(`${ML_BASE_URL}/api/v1/compliance/rag/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(props.token ? { Authorization: `Bearer ${props.token}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(text || `RAG store failed (${res.status})`);
      }

      try {
        const data = JSON.parse(text);
        const chunks = data.chunks_count ?? data.chunks ?? 'unknown';
        const vectors = Array.isArray(data.vector_ids)
          ? data.vector_ids.length
          : 'unknown';
        setUploadResult(
          `Stored successfully. Chunks: ${chunks}, vectors: ${vectors}, document_id: ${docId}`,
        );
      } catch {
        setUploadResult(`Stored successfully. Raw response: ${text}`);
      }
      setDocumentId(docId);
    } catch (err: any) {
      setError(err.message ?? 'Failed to store document in RAG');
    } finally {
      setLoadingUpload(false);
    }
  };

  const handleSearchRag = async () => {
    setError(null);
    setSearchResults([]);
    if (!searchQuery.trim()) {
      setError('Please provide a search query.');
      return;
    }
    setLoadingSearch(true);

    try {
      const payload: any = {
        query_text: searchQuery,
        top_k: 5,
        // Use a slightly lower threshold so short queries like "RTO" still return matches
        min_score: 0.3,
      };
      if (organizationId.trim()) {
        payload.organization_id = organizationId.trim();
      }

      const res = await fetch(`${ML_BASE_URL}/api/v1/compliance/rag/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(props.token ? { Authorization: `Bearer ${props.token}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(text || `RAG search failed (${res.status})`);
      }

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response from RAG search: ${text}`);
      }

      const hits = data.hits ?? data.results ?? [];
      setSearchResults(hits);
    } catch (err: any) {
      setError(err.message ?? 'Failed to search in RAG');
    } finally {
      setLoadingSearch(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>RAG Admin</h2>
        <p>
          Manage RAG content for testing and admin work. Upload real documents
          and run semantic search over stored chunks.
        </p>
      </div>

      <div className="panel-section">
        <h3>Upload document file (API → parsing → RAG)</h3>
        <p className="auth-subtitle">
          This option sends a real file through the API. The system parses it,
          saves it, and stores chunks in the RAG store.
        </p>
        <label className="auth-label">
          Document type
          <select
            className="auth-input"
            value={documentType}
            onChange={(e) =>
              setDocumentType(
                e.target.value as
                  | 'policy'
                  | 'tas'
                  | 'financial'
                  | 'evidence'
                  | 'report'
                  | 'other',
              )
            }
          >
            <option value="policy">Policy</option>
            <option value="tas">TAS (Training and Assessment Strategy)</option>
            <option value="financial">Financial</option>
            <option value="evidence">Evidence</option>
            <option value="report">Report</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="auth-label">
          Choose file
          <input
            type="file"
            className="auth-input"
            onChange={handleFileChange}
          />
        </label>
        <button
          className="primary-button"
          onClick={() => void handleUploadFileToRag()}
          disabled={loadingFileUpload || !documentFile}
        >
          {loadingFileUpload ? 'Uploading…' : 'Upload file to RAG'}
        </button>
        {uploadResult && <div className="panel-success">{uploadResult}</div>}
      </div>

      <div className="panel-section">
        <div className="panel-section-header">
          <h3>Store plain text in RAG (for quick tests)</h3>
          <button
            type="button"
            className="link-button"
            onClick={() => setShowPlainTextSection((v) => !v)}
          >
            {showPlainTextSection ? 'Hide' : 'Show'}
          </button>
        </div>
        {showPlainTextSection && (
          <>
            <label className="auth-label">
              Organization ID (optional)
              <input
                type="text"
                value={organizationId}
                onChange={(e) => setOrganizationId(e.target.value)}
                className="auth-input"
                placeholder="Leave blank to search across all RTOs"
              />
            </label>
            <label className="auth-label">
              Document ID (optional)
              <input
                type="text"
                value={documentId}
                onChange={(e) => setDocumentId(e.target.value)}
                className="auth-input"
                placeholder="If empty, will be generated"
              />
            </label>
            <label className="auth-label">
              Document text
              <textarea
                value={documentText}
                onChange={(e) => setDocumentText(e.target.value)}
                className="auth-textarea"
                placeholder="Paste document text here to store in RAG..."
                rows={8}
              />
            </label>
            <button
              className="primary-button"
              onClick={() => void handleStoreInRag()}
              disabled={loadingUpload || !documentText.trim()}
            >
              {loadingUpload ? 'Storing...' : 'Store in RAG'}
            </button>
            {uploadResult && <div className="panel-success">{uploadResult}</div>}
          </>
        )}
      </div>

      <div className="panel-section">
        <h3>Search in RAG</h3>
        <label className="auth-label">
          Search query
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="auth-input"
            placeholder="Ask about standards, policies, etc."
          />
        </label>
        <button
          className="secondary-button"
          onClick={() => void handleSearchRag()}
          disabled={loadingSearch || !searchQuery.trim()}
        >
          {loadingSearch ? 'Searching...' : 'Search'}
        </button>

        {searchResults.length > 0 && (
          <div className="rag-results">
            <h4>Top hits</h4>
            {searchResults.map((hit, index) => {
              const score = hit.score ?? hit.similarity ?? 0;
              const payload = hit.payload ?? {};
              const text = payload.text ?? '';
              return (
                <div key={index} className="rag-hit">
                  <div className="rag-hit-header">
                    <span className="rag-hit-score">
                      Score: {typeof score === 'number' ? score.toFixed(3) : score}
                    </span>
                    <span className="rag-hit-meta">
                      doc: {payload.document_id ?? 'N/A'} | chunk:{' '}
                      {payload.chunk_index ?? '?'}
                    </span>
                  </div>
                  <div className="rag-hit-text">{text}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && <div className="panel-error">{error}</div>}
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('chat');
  const [token, setToken] = useState<string | null>(null);

  return (
    <div className="app-root">
      <header className="app-header">
        <div>
          <h1>AuditAI – RTO Compliance Assistant</h1>
          <p>Ask compliance questions, upload documents, and get clear answers in one place.</p>
        </div>
        {token && (
          <button
            className="secondary-button"
            onClick={() => setToken(null)}
          >
            Sign out
          </button>
        )}
      </header>

      {!token ? (
        <main className="app-main">
          <LoginForm onLoginSuccess={setToken} />
        </main>
      ) : (
        <main className="app-main">
          <div className="tabs">
            <button
              className={`tab-button ${
                activeTab === 'chat' ? 'tab-button-active' : ''
              }`}
              onClick={() => setActiveTab('chat')}
            >
              Chat
            </button>
            <button
              className={`tab-button ${
                activeTab === 'rag' ? 'tab-button-active' : ''
              }`}
              onClick={() => setActiveTab('rag')}
            >
              RAG Admin
            </button>
          </div>

          <div className="tab-content">
            {activeTab === 'chat' ? (
              <ChatTab token={token} />
            ) : (
              <RagAdminTab token={token} />
            )}
          </div>
        </main>
      )}
    </div>
  )
}

export default App
