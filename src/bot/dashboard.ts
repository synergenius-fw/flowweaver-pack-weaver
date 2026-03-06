import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type {
  DashboardEvent,
  DashboardEventType,
  DashboardNodeState,
  DashboardNodeStatus,
  DashboardServerOptions,
  ExecutionEvent,
} from './types.js';
import type { ApprovalResult } from './approvals.js';

interface RunState {
  workflowFile: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'error';
  startedAt?: number;
  completedAt?: number;
  nodes: Map<string, DashboardNodeState>;
  events: DashboardEvent[];
  summary?: string;
}

interface PendingApproval {
  id: string;
  request: { prompt: string; context: Record<string, unknown> };
  resolve: (result: ApprovalResult) => void;
}

export class DashboardServer {
  private server: http.Server;
  private clients = new Set<http.ServerResponse>();
  private state: RunState = {
    workflowFile: '',
    status: 'idle',
    nodes: new Map(),
    events: [],
  };
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private port: number;
  private actualPort: number | null = null;

  constructor(options: Partial<DashboardServerOptions> = {}) {
    this.port = options.port ?? 4242;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server.address();
        this.actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        this.heartbeatTimer = setInterval(() => this.heartbeat(), 30_000);
        resolve(this.actualPort);
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.clients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.actualPort ?? this.port}`;
  }

  broadcast(event: DashboardEvent): void {
    this.updateState(event);
    if (this.state.events.length > 500) {
      this.state.events = this.state.events.slice(-400);
    }

    const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try { client.write(data); } catch { this.clients.delete(client); }
    }
  }

  broadcastExecution(event: ExecutionEvent): void {
    this.broadcast({
      type: event.type,
      timestamp: event.timestamp,
      nodeId: event.nodeId,
      nodeType: event.nodeType,
      error: event.error,
    });
  }

  broadcastWorkflowStart(workflowFile: string): void {
    this.state.workflowFile = workflowFile;
    this.state.status = 'running';
    this.state.startedAt = Date.now();
    this.state.completedAt = undefined;
    this.state.nodes.clear();
    this.state.events = [];
    this.state.summary = undefined;

    this.broadcast({
      type: 'workflow-start',
      timestamp: Date.now(),
    });
  }

  broadcastWorkflowComplete(summary: string, success: boolean): void {
    this.state.status = success ? 'completed' : 'failed';
    this.state.completedAt = Date.now();
    this.state.summary = summary;

    this.broadcast({
      type: 'workflow-complete',
      timestamp: Date.now(),
      summary,
    });
  }

  broadcastWorkflowError(error: string): void {
    this.state.status = 'error';
    this.state.completedAt = Date.now();

    this.broadcast({
      type: 'workflow-error',
      timestamp: Date.now(),
      error,
    });
  }

  registerApproval(
    request: { prompt: string; context: Record<string, unknown> },
    resolve: (result: ApprovalResult) => void,
  ): string {
    const id = crypto.randomUUID().slice(0, 8);
    this.pendingApprovals.set(id, { id, request, resolve });

    this.broadcast({
      type: 'approval-pending',
      timestamp: Date.now(),
      approval: { id, prompt: request.prompt, context: request.context },
    });

    return id;
  }

  removeApproval(id: string): void {
    this.pendingApprovals.delete(id);
    this.broadcast({
      type: 'approval-resolved',
      timestamp: Date.now(),
    });
  }

  hasPendingApprovals(): boolean {
    return this.pendingApprovals.size > 0;
  }

  private updateState(event: DashboardEvent): void {
    this.state.events.push(event);

    if (!event.nodeId) return;

    const existing = this.state.nodes.get(event.nodeId);
    const node: DashboardNodeState = existing ?? {
      nodeId: event.nodeId,
      nodeType: event.nodeType,
      status: 'pending',
    };

    const statusMap: Record<string, DashboardNodeStatus> = {
      'node-start': 'running',
      'node-complete': 'succeeded',
      'node-error': 'failed',
    };

    const newStatus = statusMap[event.type];
    if (newStatus) {
      node.status = newStatus;
      if (newStatus === 'running') {
        node.startedAt = event.timestamp;
      } else {
        node.completedAt = event.timestamp;
        if (node.startedAt) {
          node.durationMs = event.timestamp - node.startedAt;
        }
      }
    }

    if (event.error) node.error = event.error;
    if (event.nodeType) node.nodeType = event.nodeType;

    this.state.nodes.set(event.nodeId, node);
  }

  private heartbeat(): void {
    const data = ': heartbeat\n\n';
    for (const client of this.clients) {
      try { client.write(data); } catch { this.clients.delete(client); }
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));

      // Send init state
      const initData = {
        workflowFile: this.state.workflowFile,
        status: this.state.status,
        startedAt: this.state.startedAt,
        completedAt: this.state.completedAt,
        summary: this.state.summary,
        nodes: Object.fromEntries(this.state.nodes),
        events: this.state.events,
        pendingApprovals: Array.from(this.pendingApprovals.values()).map((a) => ({
          id: a.id,
          prompt: a.request.prompt,
          context: a.request.context,
        })),
      };
      res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        workflowFile: this.state.workflowFile,
        status: this.state.status,
        startedAt: this.state.startedAt,
        completedAt: this.state.completedAt,
        summary: this.state.summary,
        nodeCount: this.state.nodes.size,
        eventCount: this.state.events.length,
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/approve/')) {
      const id = url.pathname.split('/').pop()!;
      this.resolveApproval(id, true, req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/reject/')) {
      const id = url.pathname.split('/').pop()!;
      this.resolveApproval(id, false, req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  private resolveApproval(id: string, approved: boolean, req: http.IncomingMessage, res: http.ServerResponse): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Approval not found or already resolved' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let reason = approved ? 'approved via dashboard' : 'rejected via dashboard';
      try {
        const parsed = JSON.parse(body);
        if (parsed.reason) reason = parsed.reason;
      } catch { /* no body or invalid json, use default reason */ }

      pending.resolve({ approved, reason });
      this.removeApproval(id);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, approved, reason }));
    });
  }
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weaver Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; background: #0d1117; color: #c9d1d9; font-size: 14px; }
  .header { padding: 16px 24px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 16px; }
  .header h1 { font-size: 16px; font-weight: 600; color: #f0f6fc; }
  .badge { padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; }
  .badge.idle { background: #21262d; color: #8b949e; }
  .badge.running { background: #1f3a5f; color: #58a6ff; animation: pulse 2s infinite; }
  .badge.completed { background: #12261e; color: #3fb950; }
  .badge.failed, .badge.error { background: #3d1214; color: #f85149; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
  .timer { color: #8b949e; margin-left: auto; }
  .main { display: grid; grid-template-columns: 1fr 380px; height: calc(100vh - 53px); }
  .nodes { padding: 16px; overflow-y: auto; }
  .node-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .node-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px; }
  .node-card.running { border-color: #1f6feb; }
  .node-card.succeeded { border-color: #238636; }
  .node-card.failed { border-color: #da3633; }
  .node-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.pending { background: #484f58; }
  .dot.running { background: #58a6ff; animation: pulse 1.5s infinite; }
  .dot.succeeded { background: #3fb950; }
  .dot.failed { background: #f85149; }
  .node-id { font-weight: 600; color: #f0f6fc; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .node-type { color: #8b949e; font-size: 11px; }
  .node-time { color: #8b949e; font-size: 12px; margin-top: 4px; }
  .node-error { color: #f85149; font-size: 12px; margin-top: 4px; word-break: break-word; }
  .log-panel { background: #0d1117; border-left: 1px solid #21262d; display: flex; flex-direction: column; }
  .log-header { padding: 12px 16px; font-weight: 600; font-size: 13px; border-bottom: 1px solid #21262d; color: #f0f6fc; }
  .log-body { flex: 1; overflow-y: auto; padding: 8px 12px; font-size: 12px; line-height: 1.6; }
  .log-entry { white-space: pre-wrap; word-break: break-word; }
  .log-entry .ts { color: #484f58; }
  .log-entry .icon-start { color: #58a6ff; }
  .log-entry .icon-complete { color: #3fb950; }
  .log-entry .icon-error { color: #f85149; }
  .approval-card { background: #1c2128; border: 1px solid #d29922; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .approval-card h3 { color: #d29922; font-size: 14px; margin-bottom: 8px; }
  .approval-card pre { background: #0d1117; padding: 8px; border-radius: 4px; font-size: 11px; overflow-x: auto; margin-bottom: 12px; max-height: 200px; overflow-y: auto; color: #c9d1d9; }
  .approval-buttons { display: flex; gap: 8px; }
  .btn { padding: 6px 16px; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; }
  .btn-approve { background: #238636; color: #fff; }
  .btn-approve:hover { background: #2ea043; }
  .btn-reject { background: #da3633; color: #fff; }
  .btn-reject:hover { background: #e5534b; }
  .empty { color: #484f58; padding: 40px; text-align: center; }
  @media (max-width: 768px) { .main { grid-template-columns: 1fr; } .log-panel { border-left: none; border-top: 1px solid #21262d; max-height: 300px; } }
</style>
</head>
<body>
<div class="header">
  <h1>Weaver</h1>
  <span id="status" class="badge idle">idle</span>
  <span id="workflow" style="color:#8b949e;font-size:13px"></span>
  <span id="timer" class="timer"></span>
</div>
<div class="main">
  <div class="nodes">
    <div id="approvals"></div>
    <div id="node-grid" class="node-grid"></div>
    <div id="empty" class="empty">Waiting for workflow execution...</div>
  </div>
  <div class="log-panel">
    <div class="log-header">Event Log</div>
    <div id="log" class="log-body"></div>
  </div>
</div>
<script>
(function() {
  const state = { nodes: {}, events: [], status: 'idle', startedAt: null, approvals: [] };
  const nodeGrid = document.getElementById('node-grid');
  const logEl = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const workflowEl = document.getElementById('workflow');
  const timerEl = document.getElementById('timer');
  const emptyEl = document.getElementById('empty');
  const approvalsEl = document.getElementById('approvals');

  function connect() {
    const es = new EventSource('/events');
    es.addEventListener('init', (e) => {
      const d = JSON.parse(e.data);
      state.status = d.status;
      state.startedAt = d.startedAt;
      state.nodes = d.nodes || {};
      state.approvals = d.pendingApprovals || [];
      if (d.workflowFile) workflowEl.textContent = d.workflowFile.split('/').pop();
      for (const ev of d.events || []) addLog(ev);
      render();
    });
    ['node-start','node-complete','node-error','workflow-start','workflow-complete','workflow-error','approval-pending','approval-resolved'].forEach(type => {
      es.addEventListener(type, (e) => {
        const ev = JSON.parse(e.data);
        handleEvent(type, ev);
      });
    });
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }

  function handleEvent(type, ev) {
    if (type === 'workflow-start') {
      state.status = 'running'; state.startedAt = ev.timestamp; state.nodes = {};
      nodeGrid.innerHTML = ''; logEl.innerHTML = '';
    } else if (type === 'workflow-complete') {
      state.status = ev.summary && ev.summary.includes('fail') ? 'failed' : 'completed';
    } else if (type === 'workflow-error') {
      state.status = 'error';
    } else if (type === 'approval-pending' && ev.approval) {
      state.approvals.push(ev.approval);
    } else if (type === 'approval-resolved') {
      state.approvals = [];
    }
    if (ev.nodeId) {
      const n = state.nodes[ev.nodeId] || { nodeId: ev.nodeId, status: 'pending' };
      if (type === 'node-start') { n.status = 'running'; n.startedAt = ev.timestamp; n.nodeType = ev.nodeType; }
      if (type === 'node-complete') { n.status = 'succeeded'; n.completedAt = ev.timestamp; if (n.startedAt) n.durationMs = ev.timestamp - n.startedAt; }
      if (type === 'node-error') { n.status = 'failed'; n.error = ev.error; n.completedAt = ev.timestamp; }
      state.nodes[ev.nodeId] = n;
    }
    addLog(ev);
    render();
  }

  function addLog(ev) {
    const t = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '--:--:--';
    const icons = { 'node-start': ['>', 'icon-start'], 'node-complete': ['+', 'icon-complete'], 'node-error': ['x', 'icon-error'] };
    const [icon, cls] = icons[ev.type] || ['*', ''];
    const id = ev.nodeId || ev.type;
    const extra = ev.error ? ': ' + ev.error : (ev.summary ? ': ' + ev.summary : '');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = '<span class="ts">[' + t + ']</span> <span class="' + cls + '">' + icon + '</span> ' + esc(id) + esc(extra);
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function render() {
    statusEl.className = 'badge ' + state.status;
    statusEl.textContent = state.status;
    emptyEl.style.display = Object.keys(state.nodes).length ? 'none' : 'block';

    // Render nodes
    for (const [id, n] of Object.entries(state.nodes)) {
      let card = document.getElementById('node-' + id);
      if (!card) {
        card = document.createElement('div');
        card.id = 'node-' + id;
        card.className = 'node-card';
        card.innerHTML = '<div class="node-header"><div class="dot"></div><div class="node-id"></div></div><div class="node-type"></div><div class="node-time"></div><div class="node-error"></div>';
        nodeGrid.appendChild(card);
      }
      card.className = 'node-card ' + n.status;
      card.querySelector('.dot').className = 'dot ' + n.status;
      card.querySelector('.node-id').textContent = n.nodeId;
      card.querySelector('.node-type').textContent = n.nodeType || '';
      const timeEl = card.querySelector('.node-time');
      if (n.durationMs != null) timeEl.textContent = (n.durationMs / 1000).toFixed(1) + 's';
      else if (n.status === 'running' && n.startedAt) timeEl.setAttribute('data-start', n.startedAt);
      const errEl = card.querySelector('.node-error');
      errEl.textContent = n.error || '';
    }

    // Render approvals
    approvalsEl.innerHTML = '';
    for (const a of state.approvals) {
      const card = document.createElement('div');
      card.className = 'approval-card';
      card.innerHTML = '<h3>Approval Required</h3><pre>' + esc(JSON.stringify(a.context, null, 2)) + '</pre><div class="approval-buttons"><button class="btn btn-approve" onclick="approve(\\'' + a.id + '\\')">Approve</button><button class="btn btn-reject" onclick="reject(\\'' + a.id + '\\')">Reject</button></div>';
      approvalsEl.appendChild(card);
    }
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  window.approve = function(id) {
    fetch('/api/approve/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  };
  window.reject = function(id) {
    const reason = prompt('Rejection reason (optional):') || '';
    fetch('/api/reject/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason || 'rejected via dashboard' }) });
  };

  // Running timer
  setInterval(() => {
    if (state.status === 'running' && state.startedAt) {
      const s = ((Date.now() - state.startedAt) / 1000).toFixed(0);
      timerEl.textContent = s + 's';
    }
    // Update running node timers
    document.querySelectorAll('.node-time[data-start]').forEach(el => {
      const s = ((Date.now() - parseInt(el.getAttribute('data-start'))) / 1000).toFixed(1);
      el.textContent = s + 's';
    });
  }, 200);

  connect();
})();
</script>
</body>
</html>`;
}
