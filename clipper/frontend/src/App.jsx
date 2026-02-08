import { useState, useEffect } from "react";
import "./App.css";

const API_BASE = "/api/videos";

function App() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState(null);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchVideos = async () => {
    setLoading(true);
    try {
      const res = await fetch(API_BASE);
      if (res.ok) {
        const data = await res.json();
        setVideos(data);
        setError(null);
      } else {
        setError("System Failure: Unable to reach Video Service");
      }
    } catch (err) {
      setError("System Failure: Unable to reach Video Service");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVideos();
  }, []);

  // Auto-dismiss success messages after 10 seconds
  useEffect(() => {
    if (message?.type === "success") {
      const timer = setTimeout(() => setMessage(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!file) return;

    setUploading(true);
    setMessage(null);

    const formData = new FormData();
    formData.append("video", file);

    try {
      const res = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        body: formData
      });

      const data = await res.json();

      if (res.ok) {
        setMessage({ type: "success", text: `Video uploaded successfully. ID: ${data.video.id}` });
        setFile(null);
        setError(null);
        fetchVideos();
      } else {
        setError(data.error || "Upload failed");
        setMessage(null);
      }
    } catch (err) {
      setError("Network error: " + err.message);
      setMessage(null);
    } finally {
      setUploading(false);
    }
  };

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Clipper</h1>
        <div className={`status ${error ? "status-error" : "status-ok"}`}>
          {error ? "Critical" : "Operational"}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <section className="upload-section">
        <h2>Upload Video</h2>
        <form className="upload-form" onSubmit={handleUpload}>
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files[0])}
          />
          <button type="submit" disabled={!file || uploading}>
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </form>
        {message && (
          <div className={message.type}>{message.text}</div>
        )}
      </section>

      <section className="videos-section">
        <div className="videos-header">
          <h2>Video Queue</h2>
          <button className="refresh-btn" onClick={fetchVideos}>
            Refresh
          </button>
        </div>
        {loading ? (
          <div className="loading">Synchronizing</div>
        ) : videos.length === 0 ? (
          <div className="empty-state">No active videos found.</div>
        ) : (
          <ul className="video-list">
            {videos.map((video) => (
              <li key={video.id} className="video-item">
                <div className="video-info">
                  <div className="video-filename">{video.filename}</div>
                  <div className="video-date">{formatDate(video.created_at)}</div>
                </div>
                <span className={`video-status ${video.status}`}>
                  {video.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default App;
