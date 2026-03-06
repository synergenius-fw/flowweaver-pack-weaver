import { weaverTemplate } from '../src/templates/weaver-template.js';

describe('weaverTemplate', () => {
  it('has correct metadata', () => {
    expect(weaverTemplate.id).toBe('weaver');
    expect(weaverTemplate.category).toBe('automation');
    expect(typeof weaverTemplate.name).toBe('string');
    expect(typeof weaverTemplate.description).toBe('string');
  });

  it('generates workflow with pack node type imports', () => {
    const code = weaverTemplate.generate({});
    expect(code).toContain("from '@synergenius/flowweaver-pack-weaver/node-types'");
    expect(code).toContain('weaverLoadConfig');
    expect(code).toContain('weaverDetectProvider');
    expect(code).toContain('weaverResolveTarget');
    expect(code).toContain('weaverExecuteTarget');
    expect(code).toContain('weaverSendNotify');
    expect(code).toContain('weaverReport');
  });

  it('generates valid flow-weaver annotations', () => {
    const code = weaverTemplate.generate({});
    expect(code).toContain('@flowWeaver workflow');
    expect(code).toContain('@node cfg weaverLoadConfig');
    expect(code).toContain('@node detect weaverDetectProvider');
    expect(code).toContain('@node target weaverResolveTarget');
    expect(code).toContain('@node exec weaverExecuteTarget');
    expect(code).toContain('@node notify weaverSendNotify');
    expect(code).toContain('@node rep weaverReport');
    expect(code).toContain('@path Start -> cfg -> detect -> target -> exec -> notify -> rep -> Exit');
  });

  it('generates exportable weaver function', () => {
    const code = weaverTemplate.generate({});
    expect(code).toContain('export async function weaver(');
    expect(code).toContain('@flow-weaver-body-start');
    expect(code).toContain('@flow-weaver-body-end');
  });
});
