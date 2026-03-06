import * as path from 'node:path';
import { parseWorkflow, validateWorkflow } from '@synergenius/flow-weaver';

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

describe('workflow validation', () => {
  it('weaver.ts validates without errors', async () => {
    const result = await validateFile('weaver.ts');
    expect(result.errors).toEqual([]);
  });

  it('weaver-bot.ts validates without errors', async () => {
    const result = await validateFile('weaver-bot.ts');
    expect(result.errors).toEqual([]);
  });

  it('weaver-bot-batch.ts validates without errors', async () => {
    const result = await validateFile('weaver-bot-batch.ts');
    expect(result.errors).toEqual([]);
  });

  it('weaver-bot-session.ts validates without errors', async () => {
    const result = await validateFile('weaver-bot-session.ts');
    expect(result.errors).toEqual([]);
  });
});
