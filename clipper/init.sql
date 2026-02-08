CREATE TABLE videos (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  original_key VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE jobs (
  id SERIAL PRIMARY KEY,
  video_id INTEGER REFERENCES videos(id),
  type VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'queued',
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
