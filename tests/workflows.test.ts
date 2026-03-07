import * as path from 'node:path';
import { parseWorkflow, validateWorkflow, compileWorkflow } from '@synergenius/flow-weaver';

const workflowsDir = path.join(__dirname, '..', 'src', 'workflows');

async function validateFile(filename: string) {
  const filePath = path.join(workflowsDir, filename);
  const parseResult = await parseWorkflow(filePath);
  if (parseResult.errors.length > 0) {
    throw new Error(
      `Parse failed for ${filename}:\n${parseResult.errors.join('\n')}`,
    );
  }
  return validateWorkflow(parseResult.ast);
}

async function compileFile(filename: string) {
  const filePath = path.join(workflowsDir, filename);
  return compileWorkflow(filePath, { write: false });
}

describe('workflow validation', () => {
  it('weaver-bot.ts validates without errors', async () => {
    const result = await validateFile('weaver-bot.ts');
    expect(result.errors).toEqual([]);
  });

  it('weaver-bot-batch.ts validates without errors', async () => {
    const result = await validateFile('weaver-bot-batch.ts');
    expect(result.errors).toEqual([]);
  });

  it('genesis-task.ts validates without errors', async () => {
    const result = await validateFile('genesis-task.ts');
    expect(result.errors).toEqual([]);
  });
});

describe('workflow compilation', () => {
  it('weaver-bot.ts compiles successfully', async () => {
    const result = await compileFile('weaver-bot.ts');
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });

  it('weaver-bot-batch.ts compiles successfully', async () => {
    const result = await compileFile('weaver-bot-batch.ts');
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });

  it('genesis-task.ts compiles successfully', async () => {
    const result = await compileFile('genesis-task.ts');
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });
});
