import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function executeStep(
  step: { operation: string; args: Record<string, unknown> },
  projectDir: string,
): { file?: string; files?: string[]; created?: boolean } {
  const args = step.args;
  const file = args.file as string | undefined;

  switch (step.operation) {
    case 'write-file':
    case 'create-workflow':
    case 'modify-source':
    case 'implement-node': {
      const filePath = path.resolve(projectDir, file!);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, (args.content as string) ?? (args.body as string) ?? '', 'utf-8');
      return { file: filePath, created: !existed };
    }
    case 'compile':
      execFileSync('flow-weaver', ['compile', file!], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'validate':
      execFileSync('flow-weaver', ['validate', file!], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return {};
    case 'add-node':
      execFileSync('flow-weaver', ['modify', 'addNode', '--file', file!, '--nodeId', String(args.nodeId), '--nodeType', String(args.nodeType)], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'remove-node':
      execFileSync('flow-weaver', ['modify', 'removeNode', '--file', file!, '--nodeId', String(args.nodeId)], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'add-connection':
      execFileSync('flow-weaver', ['modify', 'addConnection', '--file', file!, '--from', String(args.from), '--to', String(args.to)], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'remove-connection':
      execFileSync('flow-weaver', ['modify', 'removeConnection', '--file', file!, '--from', String(args.from), '--to', String(args.to)], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'scaffold':
      execFileSync('flow-weaver', ['create', 'workflow', String(args.template), file!], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file!, created: true };
    case 'read-file':
      return {};
    case 'run-cli': {
      const cmd = String(args.command);
      const cliArgs = (args.args as string[])?.map(String) ?? [];
      execFileSync('flow-weaver', [cmd, ...cliArgs], { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return {};
    }
    default:
      throw new Error(`Unknown operation: ${step.operation}`);
  }
}
