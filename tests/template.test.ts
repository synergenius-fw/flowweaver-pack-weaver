import { weaverBotTemplate } from '../src/templates/weaver-bot-template.js';

describe('weaverBotTemplate', () => {
  it('has correct metadata', () => {
    expect(weaverBotTemplate.id).toBe('weaver-bot');
    expect(weaverBotTemplate.category).toBe('bot');
    expect(typeof weaverBotTemplate.name).toBe('string');
    expect(typeof weaverBotTemplate.description).toBe('string');
  });

  it('generates workflow with pack node type imports', () => {
    const code = weaverBotTemplate.generate({});
    expect(code).toContain("from '@synergenius/flowweaver-pack-weaver/node-types'");
    expect(code).toContain('weaverLoadConfig');
    expect(code).toContain('weaverDetectProvider');
    expect(code).toContain('weaverReceiveTask');
    expect(code).toContain('weaverBotReport');
  });

  it('generates valid flow-weaver annotations', () => {
    const code = weaverBotTemplate.generate({});
    expect(code).toContain('@flowWeaver workflow');
    expect(code).toContain('@node cfg');
    expect(code).toContain('@path Start ->');
    expect(code).toContain('-> Exit');
  });

  it('generates exportable weaverBot function', () => {
    const code = weaverBotTemplate.generate({});
    expect(code).toContain('export async function weaverBot(');
    expect(code).toContain('@flow-weaver-body-start');
    expect(code).toContain('@flow-weaver-body-end');
  });
});
