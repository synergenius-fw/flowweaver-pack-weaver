import type { GenesisFingerprint, GenesisContext } from '../bot/types.js';
import { GenesisStore } from '../bot/genesis-store.js';

/**
 * Compares the current project fingerprint against the last saved one,
 * producing a diff summary of file and state changes.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Genesis Diff Fingerprint
 * @input ctx [order:0] - Genesis context (JSON)
 * @output ctx [order:0] - Genesis context with diffJson (JSON)
 * @output onFailure [hidden]
 */
export function genesisDiffFingerprint(ctx: string): { ctx: string } {
  const context = JSON.parse(ctx) as GenesisContext;
  const { env } = context;
  const store = new GenesisStore(env.projectDir);
  const current = JSON.parse(context.fingerprintJson!) as GenesisFingerprint;
  const last = store.getLastFingerprint();

  const addedFiles: string[] = [];
  const removedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  let gitChanged = false;
  let workflowsChanged = false;

  if (!last) {
    const diff = {
      addedFiles: Object.keys(current.files),
      removedFiles: [],
      modifiedFiles: [],
      gitChanged: true,
      workflowsChanged: true,
    };
    context.diffJson = JSON.stringify(diff);
    return { ctx: JSON.stringify(context) };
  }

  for (const [file, hash] of Object.entries(current.files)) {
    if (!(file in last.files)) {
      addedFiles.push(file);
    } else if (last.files[file] !== hash) {
      modifiedFiles.push(file);
    }
  }
  for (const file of Object.keys(last.files)) {
    if (!(file in current.files)) {
      removedFiles.push(file);
    }
  }

  gitChanged = current.gitBranch !== last.gitBranch || current.gitCommit !== last.gitCommit;

  const currentWfs = [...current.existingWorkflows].sort().join(',');
  const lastWfs = [...last.existingWorkflows].sort().join(',');
  workflowsChanged = currentWfs !== lastWfs || current.workflowHash !== last.workflowHash;

  const diff = { addedFiles, removedFiles, modifiedFiles, gitChanged, workflowsChanged };
  const hasChanges = addedFiles.length > 0 || removedFiles.length > 0 ||
    modifiedFiles.length > 0 || gitChanged || workflowsChanged;

  console.log(`\x1b[36m→ Diff: +${addedFiles.length} -${removedFiles.length} ~${modifiedFiles.length}, git=${gitChanged}, wf=${workflowsChanged}\x1b[0m`);

  context.diffJson = JSON.stringify(diff);
  return { ctx: JSON.stringify(context) };
}
