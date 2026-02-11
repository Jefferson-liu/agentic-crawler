import { DragEvent, FormEvent, useEffect, useRef, useState } from 'react';

const AGENT_BASE_URL = import.meta.env.VITE_AGENT_API_BASE_URL ?? 'http://localhost:4111';
// Route context requests through agent backend to avoid CORS issues from browser -> external backend
const CONTEXT_API_BASE_URL = `${AGENT_BASE_URL}/api/context/`;
const CONTEXT_SCOPE = import.meta.env.VITE_CONTEXT_SCOPE ?? '';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

type RemoteFile = {
  id: string;
  name?: string;
  title?: string;
  filename?: string;
  original_name?: string;
  original_filename?: string;
  size?: number;
};

export default function App() {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadStatus, setUploadStatus] = useState('');
  const [remoteFiles, setRemoteFiles] = useState<RemoteFile[]>([]);
  const [viewingFile, setViewingFile] = useState<RemoteFile | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'assistant-welcome',
      role: 'assistant',
      content: 'Ready. Ask me anything and I will use the agent service.',
    },
  ]);
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    fetchRemoteFiles();
  }, []);

  async function fetchRemoteFiles() {
    if (!CONTEXT_API_BASE_URL) return;
    try {
      const headers: HeadersInit = {};
      if (CONTEXT_SCOPE) headers['X-Scope'] = CONTEXT_SCOPE;

      const url = new URL('data', CONTEXT_API_BASE_URL).toString();
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        // Handle array or { data: [] } shape
        const files = Array.isArray(data) ? data : data.data || [];
        setRemoteFiles(files);
      }
    } catch (e) {
      console.error('Failed to fetch remote files', e);
    }
  }

  async function deleteRemoteFile(id: string, e: React.MouseEvent) {
    // Prevent bubbling so it doesn't open the file viewer
    e.stopPropagation();

    if (!CONTEXT_API_BASE_URL) return;
    if (!confirm('Are you sure you want to delete this file?')) return;

    try {
      const headers: HeadersInit = {};
      if (CONTEXT_SCOPE) headers['X-Scope'] = CONTEXT_SCOPE;

      const url = new URL(`data/${id}`, CONTEXT_API_BASE_URL).toString();
      const res = await fetch(url, {
        method: 'DELETE',
        headers,
      });

      if (res.ok) {
        setRemoteFiles((prev) => prev.filter((f) => f.id !== id));
      } else {
        alert('Failed to delete file.');
      }
    } catch (e) {
      console.error('Failed to delete file', e);
      alert('Error deleting file.');
    }
  }

  async function openFileDetails(file: RemoteFile) {
    setViewingFile(file);
    setFileContent('Loading...');

    try {
      const headers: HeadersInit = {};
      if (CONTEXT_SCOPE) headers['X-Scope'] = CONTEXT_SCOPE;

      const url = new URL(`data/${file.id}`, CONTEXT_API_BASE_URL).toString();
      const res = await fetch(url, { headers });
      
      if (!res.ok) throw new Error('Failed to load content');
      
      const data = await res.json();
      // Heuristic to find the content in the response
      const content = data.text || data.content || data.body || JSON.stringify(data, null, 2);
      setFileContent(content);
    } catch (e) {
      console.error(e);
      setFileContent('Error loading file content.');
    }
  }

  function closeFileViewer() {
    setViewingFile(null);
    setFileContent(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');

    setIsLoading(true);

    try {
      const res = await fetch(`${AGENT_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });

      if (!res.ok) throw new Error('Agent request failed');

      const data = (await res.json()) as { reply: string };
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.reply,
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch {
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Request failed. Check backend service and config.',
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }

  function onFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    const incoming = Array.from(files);
    setSelectedFiles((prev) => [...prev, ...incoming]);
    setUploadStatus('');
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    onFilesSelected(event.dataTransfer.files);
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  async function uploadFiles() {
    if (selectedFiles.length === 0) return;
    if (!CONTEXT_API_BASE_URL) {
      setUploadStatus('Set VITE_CONTEXT_API_BASE_URL to your backend base URL.');
      return;
    }

    const formData = new FormData();
    const isSingleUpload = selectedFiles.length === 1;
    if (isSingleUpload) {
      formData.append('file', selectedFiles[0]);
    } else {
      selectedFiles.forEach((file) => formData.append('files', file));
    }

    const uploadUrl = new URL(
      isSingleUpload ? 'documents' : 'documents/bulk',
      CONTEXT_API_BASE_URL
    ).toString();
    const headers: HeadersInit = {};
    if (CONTEXT_SCOPE) {
      headers['X-Scope'] = CONTEXT_SCOPE;
    }

    setIsUploading(true);
    setUploadStatus('');

    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers,
        body: formData,
      });

      if (!res.ok) throw new Error('Upload failed');

      setUploadStatus(`Uploaded ${selectedFiles.length} file(s).`);
      setSelectedFiles([]);
      fetchRemoteFiles();
    } catch {
      setUploadStatus('Upload failed. Check backend service and try again.');
    } finally {
      setIsUploading(false);
    }
  }

  function removeFile(index: number) {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>Context Retrieval Agent Test</h1>
        <p>Chat + file upload playground wired to your agent service.</p>
      </header>

      <div className="workspace">
        <aside className="upload-block">
          <label htmlFor="file">Upload Files</label>
          <div
            className={`dropzone ${isDragging ? 'dropzone-active' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={openFilePicker}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openFilePicker();
              }
            }}
          >
            <p>Drag and drop files here</p>
            <p>or click to browse</p>
            <input
              ref={fileInputRef}
              id="file"
              className="hidden-file-input"
              type="file"
              multiple
              onChange={(e) => onFilesSelected(e.target.files)}
            />
          </div>

          {selectedFiles.length > 0 ? (
            <ul className="file-list">
              {selectedFiles.map((file, index) => (
                <li key={`${file.name}-${file.lastModified}-${index}`} className="file-item">
                  <div className="file-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                      <title>document</title>
                      <path d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0016.5 9h-1.875a1.875 1.875 0 01-1.875-1.875V5.25A3.75 3.75 0 009 1.5H5.625z" />
                      <path d="M12.971 1.816A5.23 5.23 0 0114.25 5.25v1.875c0 .207.168.375.375.375h1.875c1.148 0 2.221.719 2.668 1.745.2.46.757.653 1.201.408a0.75 0.75 0 00.32-.423c.319-1.296-1.1-2.92-2.315-4.526-1.126-1.49-2.884-2.809-5.403-2.888z" />
                    </svg>
                  </div>
                  <div className="file-info">
                    <span className="file-name" title={file.name}>
                      {file.name}
                    </span>
                    <span className="file-size">{formatBytes(file.size)}</span>
                  </div>
                  <button
                    type="button"
                    className="file-remove-btn"
                    onClick={() => removeFile(index)}
                    aria-label={`Remove ${file.name}`}
                    title="Remove file"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                      <title>remove</title>
                      <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm-1.72 6.97a.75.75 0 10-1.06 1.06L10.94 12l-1.72 1.72a.75.75 0 101.06 1.06L12 13.06l1.72 1.72a.75.75 0 101.06-1.06L13.06 12l1.72-1.72a.75.75 0 10-1.06-1.06L12 10.94l-1.72-1.72z" clipRule="evenodd" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-files">
              <small>No files selected.</small>
            </div>
          )}

          <button
            type="button"
            onClick={uploadFiles}
            disabled={isUploading || selectedFiles.length === 0}
          >
            {isUploading ? 'Uploading...' : 'Upload Files'}
          </button>
          {uploadStatus ? <p className="upload-status">{uploadStatus}</p> : null}

          <div className="remote-files-section">
            <div className="section-header">
              <h3 className="section-title">Knowledge Base</h3>
              <button
                type="button"
                className="refresh-btn"
                onClick={fetchRemoteFiles}
                title="Refresh Knowledge Base"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M4.755 10.059a7.5 7.5 0 0112.548-3.364l1.903 1.903h-3.183a.75.75 0 100 1.5h5.5a.75.75 0 00.75-.75v-5.5a.75.75 0 00-1.5 0v3.18l-1.9-1.9A9 9 0 003.206 9.632.75.75 0 004.755 10.059zm3.314 2.977a.75.75 0 00-1.16-.96l-1.903 1.903h3.183a.75.75 0 000-1.5h-5.5a.75.75 0 00-.75.75v5.5a.75.75 0 001.5 0v-3.18l1.9 1.9a9 9 0 0015.059-4.035.75.75 0 00-1.548-.426 7.5 7.5 0 01-10.793 3.424z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
            {remoteFiles.length > 0 ? (
              <ul className="file-list">
                {remoteFiles.map((file) => {
                  // Hardcoded to prefer title as requested, fallback to id only if no title.
                  const displayName = file.title || file.id;
                  return (
                    <li
                      key={file.id}
                      className="file-item clickable-file"
                      onClick={() => openFileDetails(file)}
                    >
                      <div className="file-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                          <title>indexed document</title>
                          <path
                            fillRule="evenodd"
                            d="M5.625 1.5H9a3.75 3.75 0 013.75 3.75v1.875c0 1.036.84 1.875 1.875 1.875H16.5a3.75 3.75 0 013.75 3.75v7.875c0 1.035-.84 1.875-1.875 1.875H5.625a1.875 1.875 0 01-1.875-1.875V3.375c0-1.036.84-1.875 1.875-1.875zM12.75 12a.75.75 0 00-1.5 0v2.25H9a.75.75 0 000 1.5h2.25V18a.75.75 0 001.5 0v-2.25H15a.75.75 0 000-1.5h-2.25V12z"
                            clipRule="evenodd"
                          />
                          <path d="M14.25 5.25a5.23 5.23 0 00-1.279-3.434 9.768 9.768 0 016.963 6.963A5.23 5.23 0 0016.5 7.5h-1.875a.375.375 0 01-.375-.375V5.25z" />
                        </svg>
                      </div>
                      <div className="file-info">
                        <span className="file-name" title={displayName}>
                          {displayName}
                        </span>
                        {file.size ? (
                          <span className="file-size">{formatBytes(file.size)}</span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="file-remove-btn"
                        onClick={(e) => deleteRemoteFile(file.id, e)}
                        aria-label={`Delete ${displayName}`}
                        title="Delete from Knowledge Base"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                          <title>delete</title>
                          <path
                            fillRule="evenodd"
                            d="M16.5 4.478v.227a48.816 48.816 0 013.878.512.75.75 0 11-.49 1.478l-.56-.09 1.637 11.232a4.915 4.915 0 01-4.914 4.14H8.949a4.916 4.916 0 01-4.914-4.14l1.638-11.232-.56.09a.75.75 0 11-.49-1.478C4.596 4.706 6.095 4.545 7.642 4.478A11.398 11.398 0 0110.5 2.5h3c1.07 0 2.057.29 2.91.803l.03.018a.75.75 0 01-.225 1.157zM11.25 16.5a.75.75 0 001.5 0V10.5a.75.75 0 00-1.5 0V16.5z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="empty-files">
                <small>No files indexed.</small>
              </div>
            )}
          </div>
        </aside>

        <section className="chat-shell">
          <div className="chat-thread" aria-live="polite">
            {messages.map((message) => (
              <article key={message.id} className={`bubble bubble-${message.role}`}>
                <header>{message.role === 'user' ? 'You' : 'Agent'}</header>
                <p>{message.content}</p>
              </article>
            ))}
            {isLoading ? (
              <article className="bubble bubble-assistant">
                <header>Agent</header>
                <p>Thinking...</p>
              </article>
            ) : null}
            <div ref={endOfMessagesRef} />
          </div>

          <form className="composer" onSubmit={onSubmit}>
            <label htmlFor="message">Message</label>
            <textarea
              id="message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message..."
              rows={3}
            />
            <button type="submit" disabled={isLoading || !input.trim()}>
              {isLoading ? 'Sending...' : 'Send'}
            </button>
          </form>
        </section>
      </div>

      {viewingFile && (
        <div className="modal-overlay" onClick={closeFileViewer}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <header className="modal-header">
              <h3>{viewingFile.title || viewingFile.id}</h3>
              <button className="modal-close" onClick={closeFileViewer}>
                &times;
              </button>
            </header>
            <div className="modal-body">
              <pre>{fileContent}</pre>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
