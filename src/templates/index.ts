import { weaverTemplate } from './weaver-template.js';
import { weaverBotTemplate } from './weaver-bot-template.js';

export type { WorkflowTemplate } from './weaver-template.js';
export { weaverTemplate };
export { weaverBotTemplate };
export const workflowTemplates = [weaverTemplate, weaverBotTemplate];
