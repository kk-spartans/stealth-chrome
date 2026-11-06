/** The recording web UI. Served as a static string; no framework needed. */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stealth-chrome — Recordings</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px;background:#0b0c10;color:#c5c6c7;max-width:760px;margin:0 auto}
h1{margin:0 0 16px;font-size:20px}
.card{background:#1f2024;border:1px solid #3a3b42;border-radius:8px;padding:16px;margin-bottom:16px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button{padding:8px 14px;border:none;border-radius:6px;cursor:pointer;font-weight:600}
button.rec{background:#2f8f44;color:#fff}
button.rec.recording{background:#b3261e}
button.secondary{background:#3a3b42;color:#fff}
button:disabled{opacity:.5;cursor:not-allowed}
#status{margin:8px 0 0;font-size:13px;color:#8e8f93}
ul{list-style:none;padding:0;margin:0}
li{border-bottom:1px solid #2c2d32;padding:10px 0;display:flex;justify-content:space-between;align-items:center;font-size:14px;gap:8px}
li a{color:#64b5f6;text-decoration:none;word-break:break-all}
li a:hover{text-decoration:underline}
.size{font-size:12px;color:#8e8f93;margin-left:8px;white-space:nowrap}
audio{width:100%}
.muted{color:#8e8f93;font-size:12px;margin-top:6px}
.dl{background:#3a3b42;padding:4px 8px;border-radius:4px;color:#fff !important;text-decoration:none;font-size:12px;white-space:nowrap}
</style>
</head>
<body>
<h1>Browser Recordings</h1>
<div class="card">
  <div id="status">Idle</div>
  <div class="row" style="margin-top:10px">
    <button id="recBtn" class="rec">Start Recording</button>
    <button class="secondary" id="refreshBtn">Refresh</button>
  </div>
</div>
<div class="card">
  <div style="font-weight:600;margin-bottom:8px">Recordings</div>
  <ul id="list"></ul>
</div>
<div class="card">
  <div style="font-weight:600;margin-bottom:8px">Live Audio</div>
  <audio id="audio" controls autoplay muted></audio>
  <div class="muted">Monitor of the audio sink Chrome outputs into. Unmute when ready — browsers block autoplay with sound.</div>
</div>
<script>
const statusEl = document.getElementById('status');
const recBtn = document.getElementById('recBtn');
const listEl = document.getElementById('list');
const audioEl = document.getElementById('audio');
let recording = false;

function updateBtn() {
  recBtn.textContent = recording ? 'Stop Recording' : 'Start Recording';
  recBtn.className = recording ? 'rec recording' : 'rec';
  statusEl.textContent = recording ? 'Recording…' : 'Idle';
}

async function refresh() {
  const s = await (await fetch('/api/status')).json();
  recording = !!s.recording;
  updateBtn();
  const items = await (await fetch('/api/recordings')).json();
  listEl.replaceChildren();
  for (const r of items) {
    const li = document.createElement('li');
    const name = document.createElement('a');
    name.href = r.url;
    name.download = '';
    name.textContent = r.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = (r.size / 1048576).toFixed(2) + ' MB';
    const left = document.createElement('div');
    left.append(name, size);
    const dl = document.createElement('a');
    dl.href = r.url;
    dl.download = '';
    dl.className = 'dl';
    dl.textContent = 'Download';
    li.append(left, dl);
    listEl.append(li);
  }
  if (!audioEl.src) audioEl.src = '/api/audio?' + Date.now();
}

recBtn.addEventListener('click', async () => {
  recBtn.disabled = true;
  try {
    await fetch(recording ? '/api/recordings/stop' : '/api/recordings/start', { method: 'POST' });
    recording = !recording;
    updateBtn();
    await refresh();
  } finally {
    recBtn.disabled = false;
  }
});
document.getElementById('refreshBtn').addEventListener('click', refresh);
setInterval(refresh, 3000);
refresh();
</script>
</body>
</html>
`;
