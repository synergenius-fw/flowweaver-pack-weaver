import { describe, it, expect } from 'vitest';
import { checkDesignQuality } from '../src/bot/design-checker.js';
import type { DesignReport } from '../src/bot/design-checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAst(overrides?: Partial<any>): any {
  return {
    name: 'test-workflow',
    description: overrides?.description ?? '',
    instances: overrides?.instances ?? [],
    nodeTypes: overrides?.nodeTypes ?? [],
    connections: overrides?.connections ?? [],
    scopes: overrides?.scopes ?? [],
    ui: overrides?.ui ?? { instances: [] },
    ...overrides,
  };
}

function makeInstance(id: string, extra?: Partial<any>): any {
  return { id, nodeType: extra?.nodeType ?? 'GenericNode', config: extra?.config ?? {}, ...extra };
}

function makeConnection(fromNode: string, fromPort: string, toNode: string, toPort: string): any {
  return { from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
}

function makeNodeType(name: string, extra?: Partial<any>): any {
  return { name, functionName: extra?.functionName ?? name, label: extra?.label ?? name, ...extra };
}

function findChecks(report: DesignReport, code: string) {
  return report.checks.filter((c) => c.code === code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkDesignQuality', () => {
  // -----------------------------------------------------------------------
  // Empty / baseline workflow
  // -----------------------------------------------------------------------

  describe('empty workflow', () => {
    it('returns a perfect score of 100 with no checks', () => {
      // An empty workflow still triggers WEAVER_NO_DESCRIPTION because
      // the default description is an empty string.
      const ast = makeAst({ description: 'A valid workflow' });
      const report = checkDesignQuality(ast);

      expect(report.score).toBe(100);
      expect(report.checks).toHaveLength(0);
      expect(report.failed).toBe(0);
    });

    it('empty workflow with no description triggers WEAVER_NO_DESCRIPTION only', () => {
      const ast = makeAst();
      const report = checkDesignQuality(ast);

      expect(report.checks).toHaveLength(1);
      expect(report.checks[0].code).toBe('WEAVER_NO_DESCRIPTION');
      expect(report.checks[0].severity).toBe('info');
      expect(report.score).toBe(99); // 100 - 1 (info)
    });
  });

  // -----------------------------------------------------------------------
  // WEAVER_MISSING_VISUALS
  // -----------------------------------------------------------------------

  describe('WEAVER_MISSING_VISUALS', () => {
    it('flags nodes without @color or @icon', () => {
      const ast = makeAst({
        description: 'has description',
        instances: [
          makeInstance('loadConfig'),
          makeInstance('processData'),
        ],
      });
      const report = checkDesignQuality(ast);
      const visuals = findChecks(report, 'WEAVER_MISSING_VISUALS');

      expect(visuals).toHaveLength(2);
      expect(visuals[0].severity).toBe('info');
      expect(visuals[0].nodeId).toBe('loadConfig');
      expect(visuals[1].nodeId).toBe('processData');
    });

    it('does not flag nodes that have @color', () => {
      const ast = makeAst({
        description: 'has description',
        instances: [makeInstance('loadConfig', { config: { color: '#ff0000' } })],
      });
      const report = checkDesignQuality(ast);
      const visuals = findChecks(report, 'WEAVER_MISSING_VISUALS');

      expect(visuals).toHaveLength(0);
    });

    it('does not flag nodes that have @icon', () => {
      const ast = makeAst({
        description: 'has description',
        instances: [makeInstance('loadConfig', { config: { icon: 'gear' } })],
      });
      const report = checkDesignQuality(ast);
      const visuals = findChecks(report, 'WEAVER_MISSING_VISUALS');

      expect(visuals).toHaveLength(0);
    });

    it('does not flag nodes that have both @color and @icon', () => {
      const ast = makeAst({
        description: 'has description',
        instances: [makeInstance('loadConfig', { config: { color: '#00f', icon: 'check' } })],
      });
      const report = checkDesignQuality(ast);
      const visuals = findChecks(report, 'WEAVER_MISSING_VISUALS');

      expect(visuals).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // WEAVER_GENERIC_NODE_ID
  // -----------------------------------------------------------------------

  describe('WEAVER_GENERIC_NODE_ID', () => {
    it.each(['node1', 'node', 'tmp', 'tmp2', 'foo', 'bar', 'bar2', 'x', 'x1', 'n', 'n5', 'test', 'test3'])(
      'flags generic ID "%s"',
      (id) => {
        const ast = makeAst({
          description: 'has description',
          instances: [makeInstance(id, { config: { color: '#f00' } })],
        });
        const report = checkDesignQuality(ast);
        const generic = findChecks(report, 'WEAVER_GENERIC_NODE_ID');

        expect(generic).toHaveLength(1);
        expect(generic[0].severity).toBe('warning');
        expect(generic[0].nodeId).toBe(id);
      },
    );

    it.each(['loadConfig', 'processData', 'sendEmail', 'validateInput', 'httpRequest'])(
      'does not flag descriptive ID "%s"',
      (id) => {
        const ast = makeAst({
          description: 'has description',
          instances: [makeInstance(id, { config: { color: '#f00' } })],
        });
        const report = checkDesignQuality(ast);
        const generic = findChecks(report, 'WEAVER_GENERIC_NODE_ID');

        expect(generic).toHaveLength(0);
      },
    );

    it('is case-insensitive', () => {
      const ast = makeAst({
        description: 'has description',
        instances: [
          makeInstance('NODE1', { config: { color: '#f00' } }),
          makeInstance('TMP', { config: { color: '#f00' } }),
          makeInstance('Foo', { config: { color: '#f00' } }),
        ],
      });
      const report = checkDesignQuality(ast);
      const generic = findChecks(report, 'WEAVER_GENERIC_NODE_ID');

      expect(generic).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // WEAVER_NO_DESCRIPTION
  // -----------------------------------------------------------------------

  describe('WEAVER_NO_DESCRIPTION', () => {
    it('triggers when description is empty string', () => {
      const ast = makeAst({ description: '' });
      const report = checkDesignQuality(ast);
      const desc = findChecks(report, 'WEAVER_NO_DESCRIPTION');

      expect(desc).toHaveLength(1);
      expect(desc[0].severity).toBe('info');
    });

    it('triggers when description is undefined', () => {
      const ast = makeAst();
      delete ast.description;
      const report = checkDesignQuality(ast);
      const desc = findChecks(report, 'WEAVER_NO_DESCRIPTION');

      expect(desc).toHaveLength(1);
    });

    it('does not trigger when description is present', () => {
      const ast = makeAst({ description: 'Processes incoming webhooks' });
      const report = checkDesignQuality(ast);
      const desc = findChecks(report, 'WEAVER_NO_DESCRIPTION');

      expect(desc).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // WEAVER_TOO_MANY_NODES
  // -----------------------------------------------------------------------

  describe('WEAVER_TOO_MANY_NODES', () => {
    it('does not trigger at 30 nodes', () => {
      const instances = Array.from({ length: 30 }, (_, i) =>
        makeInstance(`step${i}`, { config: { color: '#f00' } }),
      );
      const ast = makeAst({ description: 'desc', instances });
      const report = checkDesignQuality(ast);
      const tooMany = findChecks(report, 'WEAVER_TOO_MANY_NODES');

      expect(tooMany).toHaveLength(0);
    });

    it('triggers warning at 31 nodes', () => {
      const instances = Array.from({ length: 31 }, (_, i) =>
        makeInstance(`step${i}`, { config: { color: '#f00' } }),
      );
      const ast = makeAst({ description: 'desc', instances });
      const report = checkDesignQuality(ast);
      const tooMany = findChecks(report, 'WEAVER_TOO_MANY_NODES');

      expect(tooMany).toHaveLength(1);
      expect(tooMany[0].severity).toBe('warning');
    });

    it('does not trigger at 50 nodes (only warning)', () => {
      const instances = Array.from({ length: 50 }, (_, i) =>
        makeInstance(`step${i}`, { config: { color: '#f00' } }),
      );
      const ast = makeAst({ description: 'desc', instances });
      const report = checkDesignQuality(ast);
      const tooMany = findChecks(report, 'WEAVER_TOO_MANY_NODES');

      expect(tooMany).toHaveLength(1);
      expect(tooMany[0].severity).toBe('warning');
    });

    it('triggers error at 51 nodes', () => {
      const instances = Array.from({ length: 51 }, (_, i) =>
        makeInstance(`step${i}`, { config: { color: '#f00' } }),
      );
      const ast = makeAst({ description: 'desc', instances });
      const report = checkDesignQuality(ast);
      const tooMany = findChecks(report, 'WEAVER_TOO_MANY_NODES');

      expect(tooMany).toHaveLength(1);
      expect(tooMany[0].severity).toBe('error');
    });
  });

  // -----------------------------------------------------------------------
  // WEAVER_LAYOUT_DIRECTION
  // -----------------------------------------------------------------------

  describe('WEAVER_LAYOUT_DIRECTION', () => {
    it('triggers when >30% of connections flow right-to-left', () => {
      // 4 connections: 3 go right-to-left (75%), 1 goes left-to-right
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('a', { config: { color: '#f00' } }),
          makeInstance('b', { config: { color: '#f00' } }),
          makeInstance('c', { config: { color: '#f00' } }),
        ],
        connections: [
          makeConnection('a', 'out', 'b', 'in'),
          makeConnection('b', 'out', 'a', 'in'),
          makeConnection('c', 'out', 'a', 'in'),
          makeConnection('c', 'out', 'b', 'in'),
        ],
        ui: {
          instances: [
            { name: 'a', x: 100, y: 0 },
            { name: 'b', x: 300, y: 0 },
            { name: 'c', x: 500, y: 0 },
          ],
        },
      });
      const report = checkDesignQuality(ast);
      const layout = findChecks(report, 'WEAVER_LAYOUT_DIRECTION');

      expect(layout).toHaveLength(1);
      expect(layout[0].severity).toBe('info');
    });

    it('does not trigger when all connections flow left-to-right', () => {
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('a', { config: { color: '#f00' } }),
          makeInstance('b', { config: { color: '#f00' } }),
        ],
        connections: [makeConnection('a', 'out', 'b', 'in')],
        ui: {
          instances: [
            { name: 'a', x: 0, y: 0 },
            { name: 'b', x: 200, y: 0 },
          ],
        },
      });
      const report = checkDesignQuality(ast);
      const layout = findChecks(report, 'WEAVER_LAYOUT_DIRECTION');

      expect(layout).toHaveLength(0);
    });

    it('does not trigger when ui.instances has fewer than 2 entries', () => {
      const ast = makeAst({
        description: 'desc',
        instances: [makeInstance('a', { config: { color: '#f00' } })],
        connections: [],
        ui: { instances: [{ name: 'a', x: 0, y: 0 }] },
      });
      const report = checkDesignQuality(ast);
      const layout = findChecks(report, 'WEAVER_LAYOUT_DIRECTION');

      expect(layout).toHaveLength(0);
    });

    it('tolerates small backwards offsets (within 50px)', () => {
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('a', { config: { color: '#f00' } }),
          makeInstance('b', { config: { color: '#f00' } }),
        ],
        connections: [makeConnection('a', 'out', 'b', 'in')],
        ui: {
          instances: [
            { name: 'a', x: 100, y: 0 },
            { name: 'b', x: 60, y: 0 }, // only 40px backwards, within tolerance
          ],
        },
      });
      const report = checkDesignQuality(ast);
      const layout = findChecks(report, 'WEAVER_LAYOUT_DIRECTION');

      expect(layout).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // WEAVER_DEEP_NESTING
  // -----------------------------------------------------------------------

  describe('WEAVER_DEEP_NESTING', () => {
    it('triggers when scope depth exceeds 3', () => {
      // Create chain: level0 -> level1 -> level2 -> level3 -> level4
      const instances = [
        makeInstance('level0', { config: { color: '#f00' } }),
        makeInstance('level1', { config: { color: '#f00' }, parent: { id: 'level0' } }),
        makeInstance('level2', { config: { color: '#f00' }, parent: { id: 'level1' } }),
        makeInstance('level3', { config: { color: '#f00' }, parent: { id: 'level2' } }),
        makeInstance('level4', { config: { color: '#f00' }, parent: { id: 'level3' } }),
      ];
      const ast = makeAst({
        description: 'desc',
        instances,
        scopes: [{}], // just needs to be non-empty to pass the guard
      });
      const report = checkDesignQuality(ast);
      const deep = findChecks(report, 'WEAVER_DEEP_NESTING');

      // level4 is depth 4, level3 is depth 3 — only depth > 3 triggers
      expect(deep.length).toBeGreaterThanOrEqual(1);
      expect(deep.some((c) => c.nodeId === 'level4')).toBe(true);
      expect(deep.every((c) => c.severity === 'warning')).toBe(true);
    });

    it('does not trigger at depth 3 exactly', () => {
      const instances = [
        makeInstance('level0', { config: { color: '#f00' } }),
        makeInstance('level1', { config: { color: '#f00' }, parent: { id: 'level0' } }),
        makeInstance('level2', { config: { color: '#f00' }, parent: { id: 'level1' } }),
        makeInstance('level3', { config: { color: '#f00' }, parent: { id: 'level2' } }),
      ];
      const ast = makeAst({
        description: 'desc',
        instances,
        scopes: [{}],
      });
      const report = checkDesignQuality(ast);
      const deep = findChecks(report, 'WEAVER_DEEP_NESTING');

      expect(deep).toHaveLength(0);
    });

    it('does not check nesting when scopes array is absent', () => {
      const instances = [
        makeInstance('level0', { config: { color: '#f00' } }),
        makeInstance('level1', { config: { color: '#f00' }, parent: { id: 'level0' } }),
        makeInstance('level2', { config: { color: '#f00' }, parent: { id: 'level1' } }),
        makeInstance('level3', { config: { color: '#f00' }, parent: { id: 'level2' } }),
        makeInstance('level4', { config: { color: '#f00' }, parent: { id: 'level3' } }),
      ];
      const ast = makeAst({
        description: 'desc',
        instances,
        scopes: undefined,
      });
      // When scopes is falsy, checkScopeNesting returns early
      const report = checkDesignQuality(ast);
      const deep = findChecks(report, 'WEAVER_DEEP_NESTING');

      expect(deep).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // WEAVER_HIGH_FANIN
  // -----------------------------------------------------------------------

  describe('WEAVER_HIGH_FANIN', () => {
    it('triggers when a node receives >5 data connections', () => {
      const sources = Array.from({ length: 6 }, (_, i) =>
        makeInstance(`source${i}`, { config: { color: '#f00' } }),
      );
      const target = makeInstance('aggregator', { config: { color: '#f00' } });
      const connections = sources.map((s) =>
        makeConnection(s.id, 'output', 'aggregator', 'dataIn'),
      );
      const ast = makeAst({
        description: 'desc',
        instances: [...sources, target],
        connections,
      });
      const report = checkDesignQuality(ast);
      const fanIn = findChecks(report, 'WEAVER_HIGH_FANIN');

      expect(fanIn).toHaveLength(1);
      expect(fanIn[0].severity).toBe('warning');
      expect(fanIn[0].nodeId).toBe('aggregator');
    });

    it('does not trigger at exactly 5 data connections', () => {
      const sources = Array.from({ length: 5 }, (_, i) =>
        makeInstance(`source${i}`, { config: { color: '#f00' } }),
      );
      const target = makeInstance('aggregator', { config: { color: '#f00' } });
      const connections = sources.map((s) =>
        makeConnection(s.id, 'output', 'aggregator', 'dataIn'),
      );
      const ast = makeAst({
        description: 'desc',
        instances: [...sources, target],
        connections,
      });
      const report = checkDesignQuality(ast);
      const fanIn = findChecks(report, 'WEAVER_HIGH_FANIN');

      expect(fanIn).toHaveLength(0);
    });

    it('excludes execute and start port connections from fan-in count', () => {
      const sources = Array.from({ length: 7 }, (_, i) =>
        makeInstance(`source${i}`, { config: { color: '#f00' } }),
      );
      const target = makeInstance('aggregator', { config: { color: '#f00' } });
      // All connections go to 'execute' port — these should be excluded
      const connections = sources.map((s) =>
        makeConnection(s.id, 'onSuccess', 'aggregator', 'execute'),
      );
      const ast = makeAst({
        description: 'desc',
        instances: [...sources, target],
        connections,
      });
      const report = checkDesignQuality(ast);
      const fanIn = findChecks(report, 'WEAVER_HIGH_FANIN');

      expect(fanIn).toHaveLength(0);
    });

    it('excludes start port connections from fan-in count', () => {
      const sources = Array.from({ length: 7 }, (_, i) =>
        makeInstance(`source${i}`, { config: { color: '#f00' } }),
      );
      const target = makeInstance('aggregator', { config: { color: '#f00' } });
      const connections = sources.map((s) =>
        makeConnection(s.id, 'onSuccess', 'aggregator', 'start'),
      );
      const ast = makeAst({
        description: 'desc',
        instances: [...sources, target],
        connections,
      });
      const report = checkDesignQuality(ast);
      const fanIn = findChecks(report, 'WEAVER_HIGH_FANIN');

      expect(fanIn).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // WEAVER_HIGH_FANOUT
  // -----------------------------------------------------------------------

  describe('WEAVER_HIGH_FANOUT', () => {
    it('triggers when a node fans out to >4 unique step targets', () => {
      const targets = Array.from({ length: 5 }, (_, i) =>
        makeInstance(`target${i}`, { config: { color: '#f00' } }),
      );
      const source = makeInstance('dispatcher', { config: { color: '#f00' } });
      const connections = targets.map((t) =>
        makeConnection('dispatcher', 'onSuccess', t.id, 'execute'),
      );
      const ast = makeAst({
        description: 'desc',
        instances: [source, ...targets],
        connections,
      });
      const report = checkDesignQuality(ast);
      const fanOut = findChecks(report, 'WEAVER_HIGH_FANOUT');

      expect(fanOut).toHaveLength(1);
      expect(fanOut[0].severity).toBe('warning');
      expect(fanOut[0].nodeId).toBe('dispatcher');
    });

    it('does not trigger at exactly 4 unique step targets', () => {
      const targets = Array.from({ length: 4 }, (_, i) =>
        makeInstance(`target${i}`, { config: { color: '#f00' } }),
      );
      const source = makeInstance('dispatcher', { config: { color: '#f00' } });
      const connections = targets.map((t) =>
        makeConnection('dispatcher', 'onSuccess', t.id, 'execute'),
      );
      const ast = makeAst({
        description: 'desc',
        instances: [source, ...targets],
        connections,
      });
      const report = checkDesignQuality(ast);
      const fanOut = findChecks(report, 'WEAVER_HIGH_FANOUT');

      expect(fanOut).toHaveLength(0);
    });

    it('counts unique targets, not total connections', () => {
      // 6 connections but only 3 unique targets — should not trigger
      const targets = Array.from({ length: 3 }, (_, i) =>
        makeInstance(`target${i}`, { config: { color: '#f00' } }),
      );
      const source = makeInstance('dispatcher', { config: { color: '#f00' } });
      const connections = [
        makeConnection('dispatcher', 'onSuccess', 'target0', 'execute'),
        makeConnection('dispatcher', 'onFailure', 'target0', 'execute'),
        makeConnection('dispatcher', 'onSuccess', 'target1', 'execute'),
        makeConnection('dispatcher', 'onFailure', 'target1', 'execute'),
        makeConnection('dispatcher', 'onSuccess', 'target2', 'execute'),
        makeConnection('dispatcher', 'onFailure', 'target2', 'execute'),
      ];
      const ast = makeAst({
        description: 'desc',
        instances: [source, ...targets],
        connections,
      });
      const report = checkDesignQuality(ast);
      const fanOut = findChecks(report, 'WEAVER_HIGH_FANOUT');

      expect(fanOut).toHaveLength(0);
    });

    it('only counts step-port connections (not data connections)', () => {
      const targets = Array.from({ length: 6 }, (_, i) =>
        makeInstance(`target${i}`, { config: { color: '#f00' } }),
      );
      const source = makeInstance('dispatcher', { config: { color: '#f00' } });
      // Using non-step port 'dataOut'
      const connections = targets.map((t) =>
        makeConnection('dispatcher', 'dataOut', t.id, 'dataIn'),
      );
      const ast = makeAst({
        description: 'desc',
        instances: [source, ...targets],
        connections,
      });
      const report = checkDesignQuality(ast);
      const fanOut = findChecks(report, 'WEAVER_HIGH_FANOUT');

      expect(fanOut).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // WEAVER_NO_NOTIFICATION
  // -----------------------------------------------------------------------

  describe('WEAVER_NO_NOTIFICATION', () => {
    it('triggers when side-effect nodes exist but no notification node', () => {
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('sendData', { config: { color: '#f00' } }),
        ],
      });
      const report = checkDesignQuality(ast);
      const notify = findChecks(report, 'WEAVER_NO_NOTIFICATION');

      expect(notify).toHaveLength(1);
      expect(notify[0].severity).toBe('info');
    });

    it('does not trigger when a notification node is present', () => {
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('deployApp', { config: { color: '#f00' } }),
          makeInstance('slackNotify', { config: { color: '#f00' } }),
        ],
      });
      const report = checkDesignQuality(ast);
      const notify = findChecks(report, 'WEAVER_NO_NOTIFICATION');

      expect(notify).toHaveLength(0);
    });

    it('does not trigger when there are no side-effect nodes', () => {
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('loadConfig', { config: { color: '#f00' } }),
          makeInstance('parseData', { config: { color: '#f00' } }),
        ],
      });
      const report = checkDesignQuality(ast);
      const notify = findChecks(report, 'WEAVER_NO_NOTIFICATION');

      expect(notify).toHaveLength(0);
    });

    it('detects side-effects via nodeType name/functionName/label', () => {
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('myStep', {
            nodeType: 'FileWriter',
            config: { color: '#f00' },
          }),
        ],
        nodeTypes: [
          makeNodeType('FileWriter', { functionName: 'writeFile', label: 'Write File' }),
        ],
      });
      const report = checkDesignQuality(ast);
      const notify = findChecks(report, 'WEAVER_NO_NOTIFICATION');

      expect(notify).toHaveLength(1);
    });

    it('recognizes various notification patterns', () => {
      const notifyPatterns = ['notifyUser', 'emailAlert', 'slackMessage', 'webhookReporter', 'summaryStep'];
      for (const id of notifyPatterns) {
        const ast = makeAst({
          description: 'desc',
          instances: [
            makeInstance('deleteRecords', { config: { color: '#f00' } }),
            makeInstance(id, { config: { color: '#f00' } }),
          ],
        });
        const report = checkDesignQuality(ast);
        const notify = findChecks(report, 'WEAVER_NO_NOTIFICATION');

        expect(notify).toHaveLength(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Score calculation
  // -----------------------------------------------------------------------

  describe('score calculation', () => {
    it('deducts 1 point per info check', () => {
      // 3 nodes without visuals (info) = -3 points, plus no other issues
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('loadA'),
          makeInstance('loadB'),
          makeInstance('loadC'),
        ],
      });
      const report = checkDesignQuality(ast);
      const infoChecks = report.checks.filter((c) => c.severity === 'info');
      const warningChecks = report.checks.filter((c) => c.severity === 'warning');
      const errorChecks = report.checks.filter((c) => c.severity === 'error');

      const expectedScore = 100 - (infoChecks.length * 1) - (warningChecks.length * 3) - (errorChecks.length * 10);
      expect(report.score).toBe(expectedScore);
    });

    it('deducts 3 points per warning check', () => {
      // 2 generic IDs (warning) = -6
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('node1', { config: { color: '#f00' } }),
          makeInstance('tmp2', { config: { color: '#f00' } }),
        ],
      });
      const report = checkDesignQuality(ast);
      const warnings = report.checks.filter((c) => c.severity === 'warning');

      expect(warnings).toHaveLength(2);
      expect(report.score).toBe(100 - 2 * 3); // 94
    });

    it('deducts 10 points per error check', () => {
      const instances = Array.from({ length: 51 }, (_, i) =>
        makeInstance(`step${i}`, { config: { color: '#f00' } }),
      );
      const ast = makeAst({ description: 'desc', instances });
      const report = checkDesignQuality(ast);
      const errors = report.checks.filter((c) => c.severity === 'error');

      expect(errors).toHaveLength(1);
      // Score = 100 - 10 (error) = 90
      // (no other checks should fire since IDs are descriptive and have color)
      expect(report.score).toBe(90);
    });

    it('score floors at 0, never goes negative', () => {
      // Create many warnings: 40 generic IDs = 40 * 3 = 120 penalty
      const instances = Array.from({ length: 40 }, (_, i) =>
        makeInstance(`node${i}`, { config: { color: '#f00' } }),
      );
      const ast = makeAst({ description: 'desc', instances });
      const report = checkDesignQuality(ast);

      expect(report.score).toBeGreaterThanOrEqual(0);
    });

    it('combines penalties from multiple check types', () => {
      // 1 generic ID (warning=3) + 1 missing visuals (info=1) + no description (info=1)
      const ast = makeAst({
        instances: [makeInstance('node1')],
      });
      const report = checkDesignQuality(ast);

      const infoCount = report.checks.filter((c) => c.severity === 'info').length;
      const warnCount = report.checks.filter((c) => c.severity === 'warning').length;
      const errorCount = report.checks.filter((c) => c.severity === 'error').length;
      const expectedScore = Math.max(0, 100 - (infoCount * 1) - (warnCount * 3) - (errorCount * 10));

      expect(report.score).toBe(expectedScore);
    });
  });

  // -----------------------------------------------------------------------
  // Report structure (passed / failed)
  // -----------------------------------------------------------------------

  describe('report structure', () => {
    it('failed equals total checks count', () => {
      const ast = makeAst({
        instances: [makeInstance('node1')],
      });
      const report = checkDesignQuality(ast);

      expect(report.failed).toBe(report.checks.length);
    });

    it('passed = max(0, totalPossible - failed) where totalPossible = instances*2 + 4', () => {
      const ast = makeAst({
        description: 'desc',
        instances: [
          makeInstance('loadConfig', { config: { color: '#f00' } }),
          makeInstance('processData', { config: { icon: 'gear' } }),
        ],
      });
      const report = checkDesignQuality(ast);
      const totalPossible = 2 * 2 + 4; // 8

      expect(report.passed).toBe(totalPossible - report.failed);
    });

    it('passed never goes below 0', () => {
      // Many nodes = many checks, potentially more failed than totalPossible
      const instances = Array.from({ length: 51 }, (_, i) =>
        makeInstance(`node${i}`),
      );
      const ast = makeAst({ instances });
      const report = checkDesignQuality(ast);

      expect(report.passed).toBeGreaterThanOrEqual(0);
    });
  });
});
