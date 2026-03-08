import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCommand } from '@synergenius/flow-weaver';

export async function executeStep(
  step: { operation: string; args: Record<string, unknown> },
  projectDir: string,
): Promise<{ file?: string; files?: string[]; created?: boolean; output?: string }> {
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
    case 'read-file':
      return {};
    default: {
      const result = await runCommand(step.operation, { ...args, cwd: projectDir });
      return {
        file: result.files?.[0],
        files: result.files,
        output: result.output ?? (result.data ? JSON.stringify(result.data, null, 2) : undefined),
      };
    }
  }
}
