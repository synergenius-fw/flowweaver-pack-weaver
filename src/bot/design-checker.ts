/**
 * Weaver Design Quality Checker
 *
 * Heuristic, context-dependent design checks that the bot evaluates during
 * its exec-validate-retry loop and genesis proposal validation. These are
 * opinionated recommendations, not core validator rules.
 *
 * Checks structural quality, complexity limits, and completeness.
 */

import type { TWorkflowAST, TNodeInstanceAST, TNodeTypeAST } from '@synergenius/flow-weaver';

export interface DesignCheck {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  nodeId?: string;
}

export interface DesignReport {
  score: number; // 0-100
  checks: DesignCheck[];
  passed: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveNodeType(ast: TWorkflowAST, instance: TNodeInstanceAST): TNodeTypeAST | undefined {
  return ast.nodeTypes.find(
    (nt) => nt.name === instance.nodeType || nt.functionName === instance.nodeType,
  );
}

function getOutgoing(ast: TWorkflowAST, nodeId: string, portName?: string) {
  return ast.connections.filter((c) => {
    if (c.from.node !== nodeId) return false;
    if (portName && c.from.port !== portName) return false;
    return true;
  });
}

function getIncoming(ast: TWorkflowAST, nodeId: string) {
  return ast.connections.filter((c) => c.to.node === nodeId);
}

const GENERIC_ID_PATTERN = /^(node|n|tmp|x|test|foo|bar)\d*$/i;

// ---------------------------------------------------------------------------
// Structural Quality Checks
// ---------------------------------------------------------------------------

function checkVisualAnnotations(ast: TWorkflowAST): DesignCheck[] {
  const checks: DesignCheck[] = [];
  for (const inst of ast.instances) {
    const hasColor = inst.config?.color;
    const hasIcon = inst.config?.icon;
    if (!hasColor && !hasIcon) {
      checks.push({
        code: 'WEAVER_MISSING_VISUALS',
        severity: 'info',
        message: `Node '${inst.id}' has no @color or @icon set. Visual annotations help readability.`,
        nodeId: inst.id,
      });
    }
  }
  return checks;
}

function checkDescriptiveIds(ast: TWorkflowAST): DesignCheck[] {
  const checks: DesignCheck[] = [];
  for (const inst of ast.instances) {
    if (GENERIC_ID_PATTERN.test(inst.id)) {
      checks.push({
        code: 'WEAVER_GENERIC_NODE_ID',
        severity: 'warning',
        message: `Node instance ID '${inst.id}' is generic. Use a descriptive ID that reflects the node's purpose.`,
        nodeId: inst.id,
      });
    }
  }
  return checks;
}

function checkFlowDirection(ast: TWorkflowAST): DesignCheck[] {
  const checks: DesignCheck[] = [];
  if (!ast.ui?.instances || ast.ui.instances.length < 2) return checks;

  // Check if x-positions generally increase along step connections
  const posMap = new Map<string, number>();
  for (const uiNode of ast.ui.instances) {
    posMap.set(uiNode.name, uiNode.x);
  }

  let violations = 0;
  let total = 0;
  for (const conn of ast.connections) {
    const fromX = posMap.get(conn.from.node);
    const toX = posMap.get(conn.to.node);
    if (fromX !== undefined && toX !== undefined) {
      total++;
      if (toX < fromX - 50) violations++; // Allow small tolerance
    }
  }

  if (total > 0 && violations / total > 0.3) {
    checks.push({
      code: 'WEAVER_LAYOUT_DIRECTION',
      severity: 'info',
      message: `${violations} of ${total} connections flow right-to-left. Consider a left-to-right or top-to-bottom layout for readability.`,
    });
  }

  return checks;
}

function checkDescription(ast: TWorkflowAST): DesignCheck[] {
  if (!ast.description) {
    return [{
      code: 'WEAVER_NO_DESCRIPTION',
      severity: 'info',
      message: 'Workflow has no JSDoc description. A short summary helps collaborators understand its purpose.',
    }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Complexity Checks
// ---------------------------------------------------------------------------

function checkNodeCount(ast: TWorkflowAST): DesignCheck[] {
  const checks: DesignCheck[] = [];
  const count = ast.instances.length;

  if (count > 50) {
    checks.push({
      code: 'WEAVER_TOO_MANY_NODES',
      severity: 'error',
      message: `Workflow has ${count} nodes (limit: 50). Extract sub-workflows to reduce complexity.`,
    });
  } else if (count > 30) {
    checks.push({
      code: 'WEAVER_TOO_MANY_NODES',
      severity: 'warning',
      message: `Workflow has ${count} nodes (recommended limit: 30). Consider extracting sub-workflows.`,
    });
  }

  return checks;
}

function checkScopeNesting(ast: TWorkflowAST): DesignCheck[] {
  const checks: DesignCheck[] = [];
  if (!ast.scopes) return checks;

  // Build parent chain: instance -> scope -> parent instance
  const instanceScopeDepth = new Map<string, number>();

  function getDepth(instanceId: string, visited: Set<string>): number {
    if (visited.has(instanceId)) return 0;
    visited.add(instanceId);

    const cached = instanceScopeDepth.get(instanceId);
    if (cached !== undefined) return cached;

    const inst = ast.instances.find((i) => i.id === instanceId);
    if (!inst?.parent) {
      instanceScopeDepth.set(instanceId, 0);
      return 0;
    }

    const parentDepth = getDepth(inst.parent.id, visited);
    const depth = parentDepth + 1;
    instanceScopeDepth.set(instanceId, depth);
    return depth;
  }

  for (const inst of ast.instances) {
    const depth = getDepth(inst.id, new Set());
    if (depth > 3) {
      checks.push({
        code: 'WEAVER_DEEP_NESTING',
        severity: 'warning',
        message: `Node '${inst.id}' is nested ${depth} scopes deep (limit: 3). Deep nesting makes workflows hard to follow.`,
        nodeId: inst.id,
      });
    }
  }

  return checks;
}

function checkFanInComplexity(ast: TWorkflowAST): DesignCheck[] {
  const checks: DesignCheck[] = [];

  for (const inst of ast.instances) {
    const dataIn = getIncoming(ast, inst.id).filter(
      (c) => c.to.port !== 'execute' && c.to.port !== 'start',
    );
    if (dataIn.length > 5) {
      checks.push({
        code: 'WEAVER_HIGH_FANIN',
        severity: 'warning',
        message: `Node '${inst.id}' receives ${dataIn.length} data connections (limit: 5). This may be a bottleneck.`,
        nodeId: inst.id,
      });
    }
  }

  return checks;
}

function checkFanOutComplexity(ast: TWorkflowAST): DesignCheck[] {
  const checks: DesignCheck[] = [];
  const stepPorts = new Set(['onSuccess', 'onFailure', 'execute', 'start', 'success', 'failure']);

  for (const inst of ast.instances) {
    const stepOut = getOutgoing(ast, inst.id).filter((c) => stepPorts.has(c.from.port));
    const uniqueTargets = new Set(stepOut.map((c) => c.to.node));
    if (uniqueTargets.size > 4) {
      checks.push({
        code: 'WEAVER_HIGH_FANOUT',
        severity: 'warning',
        message: `Node '${inst.id}' fans out to ${uniqueTargets.size} step targets (limit: 4). High branching increases complexity.`,
        nodeId: inst.id,
      });
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Completeness Checks
// ---------------------------------------------------------------------------

function checkNotificationPresence(ast: TWorkflowAST): DesignCheck[] {
  const checks: DesignCheck[] = [];

  // Check if workflow has side-effect nodes (heuristic: async nodes with write/send/push-like names)
  const sideEffectPattern = /write|send|push|post|create|delete|update|deploy|publish|upload|notify/i;
  const hasSideEffects = ast.instances.some((inst) => {
    const nt = resolveNodeType(ast, inst);
    const nameHint = `${inst.id} ${nt?.name ?? ''} ${nt?.functionName ?? ''} ${nt?.label ?? ''}`;
    return sideEffectPattern.test(nameHint);
  });

  if (!hasSideEffects) return checks;

  // Check if there's a notification-like node
  const notifyPattern = /notify|notification|alert|report|summary|slack|email|webhook|message/i;
  const hasNotification = ast.instances.some((inst) => {
    const nt = resolveNodeType(ast, inst);
    const nameHint = `${inst.id} ${nt?.name ?? ''} ${nt?.functionName ?? ''} ${nt?.label ?? ''}`;
    return notifyPattern.test(nameHint);
  });

  if (!hasNotification) {
    checks.push({
      code: 'WEAVER_NO_NOTIFICATION',
      severity: 'info',
      message: 'Workflow has side-effect nodes but no notification or reporting node. Consider adding one for observability.',
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Score calculation
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHTS: Record<string, number> = {
  error: 10,
  warning: 3,
  info: 1,
};

function calculateScore(checks: DesignCheck[]): number {
  if (checks.length === 0) return 100;

  let penalty = 0;
  for (const check of checks) {
    penalty += SEVERITY_WEIGHTS[check.severity] ?? 1;
  }

  // Cap at 0
  return Math.max(0, 100 - penalty);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function checkDesignQuality(ast: TWorkflowAST): DesignReport {
  const allCheckers = [
    checkVisualAnnotations,
    checkDescriptiveIds,
    checkFlowDirection,
    checkDescription,
    checkNodeCount,
    checkScopeNesting,
    checkFanInComplexity,
    checkFanOutComplexity,
    checkNotificationPresence,
  ];

  const checks: DesignCheck[] = [];
  for (const checker of allCheckers) {
    checks.push(...checker(ast));
  }

  const failed = checks.length;
  // Total possible checks is roughly: instances * 2 (visuals, id) + 4 (globals)
  const totalPossible = ast.instances.length * 2 + 4;
  const passed = Math.max(0, totalPossible - failed);

  return {
    score: calculateScore(checks),
    checks,
    passed,
    failed,
  };
}
