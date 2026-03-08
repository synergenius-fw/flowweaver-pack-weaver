import { parseWorkflow, validateWorkflow } from '@synergenius/flow-weaver';
import type { TWorkflowAST } from '@synergenius/flow-weaver';

export async function fwValidate(filePath: string): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
  ast: TWorkflowAST;
}> {
  const parseResult = await parseWorkflow(filePath);
  if (parseResult.errors.length > 0) {
    return { valid: false, errors: parseResult.errors, warnings: parseResult.warnings, ast: parseResult.ast };
  }
  const validation = validateWorkflow(parseResult.ast);
  const errors = validation.errors.map((e) => typeof e === 'string' ? e : e.message);
  const warnings = validation.warnings.map((w) => typeof w === 'string' ? w : w.message);
  return { valid: errors.length === 0, errors, warnings, ast: parseResult.ast };
}
