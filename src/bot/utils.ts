import { exec } from 'node:child_process';

export function openBrowser(url: string): void {
  let cmd: string;
  if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (process.platform === 'win32') {
    // Windows 'start' treats the first quoted string as a window title,
    // so we pass an empty title before the URL
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) console.log(`[weaver] Could not open browser. Visit: ${url}`);
  });
}
