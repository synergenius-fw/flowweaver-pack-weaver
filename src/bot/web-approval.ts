import * as http from 'node:http';
import type { NotificationEvent } from './types.js';
import type { ApprovalHandler, ApprovalRequest, ApprovalResult } from './approvals.js';
import type { DashboardServer } from './dashboard.js';
import { openBrowser } from './utils.js';

export class WebApprovalHandler implements ApprovalHandler {
  private timeoutSeconds: number;
  private shouldOpen: boolean;
  private notifier: (event: NotificationEvent) => Promise<void>;
  private dashboardServer?: DashboardServer;

  constructor(options: {
    timeoutSeconds: number;
    open?: boolean;
    notifier: (event: NotificationEvent) => Promise<void>;
    dashboardServer?: DashboardServer;
  }) {
    this.timeoutSeconds = options.timeoutSeconds;
    this.shouldOpen = options.open ?? true;
    this.notifier = options.notifier;
    this.dashboardServer = options.dashboardServer;
  }

  async handle(
    request: ApprovalRequest,
    event: NotificationEvent,
  ): Promise<ApprovalResult> {
    await this.notifier(event);

    // Dashboard mode: register with existing dashboard
    if (this.dashboardServer) {
      return this.handleViaDashboard(request);
    }

    // Standalone mode: spin up a temporary server
    return this.handleStandalone(request);
  }

  private handleViaDashboard(request: ApprovalRequest): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      const id = this.dashboardServer!.registerApproval(
        { prompt: request.prompt, context: request.context },
        resolve,
      );

      const url = `${this.dashboardServer!.getUrl()}`;
      console.log(`[weaver] Approval pending at ${url}`);

      // Timeout auto-approves
      const timer = setTimeout(() => {
        this.dashboardServer!.removeApproval(id);
        resolve({
          approved: true,
          reason: `auto-approved after ${this.timeoutSeconds}s timeout`,
        });
      }, this.timeoutSeconds * 1000);

      // Wrap resolve to also clear timeout
      const originalResolve = resolve;
      const wrappedResolve = (result: ApprovalResult) => {
        clearTimeout(timer);
        originalResolve(result);
      };

      // Re-register with wrapped resolve
      this.dashboardServer!.removeApproval(id);
      this.dashboardServer!.registerApproval(
        { prompt: request.prompt, context: request.context },
        wrappedResolve,
      );
    });
  }

  private handleStandalone(request: ApprovalRequest): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      let resolved = false;
      let server: http.Server;

      const doResolve = (result: ApprovalResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        server.close();
        resolve(result);
      };

      const timer = setTimeout(() => {
        doResolve({
          approved: true,
          reason: `auto-approved after ${this.timeoutSeconds}s timeout`,
        });
      }, this.timeoutSeconds * 1000);

      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(getApprovalHtml(request, this.timeoutSeconds));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/approve') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          doResolve({ approved: true, reason: 'approved via web UI' });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/reject') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            let reason = 'rejected via web UI';
            try {
              const parsed = JSON.parse(body);
              if (parsed.reason) reason = parsed.reason;
            } catch { /* use default */ }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            doResolve({ approved: false, reason });
          });
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      // Port 0 = OS picks a free port
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const url = `http://127.0.0.1:${port}`;
        console.log(`[weaver] Approval page: ${url}`);
        if (this.shouldOpen) openBrowser(url);
      });
    });
  }
}

function getApprovalHtml(request: ApprovalRequest, timeoutSeconds: number): string {
  // Safe injection: double-encode JSON to prevent XSS
  const safeContext = JSON.stringify(JSON.stringify(request.context, null, 2));
  const safePrompt = JSON.stringify(request.prompt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weaver Approval</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f8fa; color: #24292f; display: flex; justify-content: center; padding: 40px 16px; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 12px; max-width: 640px; width: 100%; padding: 32px; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  .timer { color: #656d76; font-size: 14px; margin-bottom: 20px; }
  .prompt { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin-bottom: 20px; font-size: 14px; line-height: 1.5; }
  .context { background: #0d1117; color: #c9d1d9; border-radius: 8px; padding: 16px; margin-bottom: 24px; font-family: 'SF Mono', monospace; font-size: 13px; line-height: 1.5; overflow-x: auto; max-height: 400px; overflow-y: auto; white-space: pre-wrap; }
  .actions { display: flex; gap: 12px; }
  .btn { padding: 10px 24px; border: none; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer; flex: 1; }
  .btn-approve { background: #2da44e; color: #fff; }
  .btn-approve:hover { background: #218838; }
  .btn-reject { background: #cf222e; color: #fff; }
  .btn-reject:hover { background: #a40e26; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .reason { width: 100%; margin-bottom: 12px; padding: 8px 12px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; font-family: inherit; display: none; }
  .done { text-align: center; padding: 20px; font-size: 16px; }
  .done.approved { color: #2da44e; }
  .done.rejected { color: #cf222e; }
</style>
</head>
<body>
<div class="card">
  <div id="form">
    <h1>Approval Required</h1>
    <div class="timer" id="timer">Auto-approves in ${timeoutSeconds}s</div>
    <div class="prompt" id="prompt"></div>
    <div class="context" id="context"></div>
    <textarea class="reason" id="reason" placeholder="Rejection reason (optional)" rows="2"></textarea>
    <div class="actions">
      <button class="btn btn-approve" id="approveBtn" onclick="doApprove()">Approve</button>
      <button class="btn btn-reject" id="rejectBtn" onclick="showReject()">Reject</button>
    </div>
  </div>
  <div id="result" class="done" style="display:none"></div>
</div>
<script>
  var deadline = Date.now() + ${timeoutSeconds * 1000};
  document.getElementById('prompt').textContent = ${safePrompt};
  document.getElementById('context').textContent = JSON.parse(${safeContext});
  var submitted = false;

  function doApprove() {
    if (submitted) return;
    submitted = true;
    fetch('/api/approve', { method: 'POST' }).then(function() {
      document.getElementById('form').style.display = 'none';
      document.getElementById('result').style.display = 'block';
      document.getElementById('result').className = 'done approved';
      document.getElementById('result').textContent = 'Approved. You can close this tab.';
    });
  }

  function showReject() {
    document.getElementById('reason').style.display = 'block';
    document.getElementById('rejectBtn').textContent = 'Confirm Reject';
    document.getElementById('rejectBtn').onclick = doReject;
  }

  function doReject() {
    if (submitted) return;
    submitted = true;
    var reason = document.getElementById('reason').value || 'rejected via web UI';
    fetch('/api/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason }) }).then(function() {
      document.getElementById('form').style.display = 'none';
      document.getElementById('result').style.display = 'block';
      document.getElementById('result').className = 'done rejected';
      document.getElementById('result').textContent = 'Rejected. You can close this tab.';
    });
  }

  setInterval(function() {
    if (submitted) return;
    var remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    document.getElementById('timer').textContent = 'Auto-approves in ' + remaining + 's';
    if (remaining <= 0) {
      document.getElementById('form').style.display = 'none';
      document.getElementById('result').style.display = 'block';
      document.getElementById('result').className = 'done approved';
      document.getElementById('result').textContent = 'Auto-approved (timeout). You can close this tab.';
      submitted = true;
    }
  }, 1000);
</script>
</body>
</html>`;
}
