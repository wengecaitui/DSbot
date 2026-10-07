import { createProductionSpine as createSpine, type ProductionSpine, type ProductionSpineConfig } from '../../src/position/ProductionSpine';
import type { ProductionEvidencePublisher, ProductionKernelReadView, RiskMandateOperatorAuthority } from '../../src/position/ProductionAuthorityPorts';

// Test composition owns these capabilities; the production spine exposes no lookup.
const ports = new WeakMap<ProductionSpine, ProductionEvidencePublisher & ProductionKernelReadView>();
const operators = new WeakMap<ProductionSpine, RiskMandateOperatorAuthority>();
const evidencePorts = new WeakMap<ProductionSpine, ProductionEvidencePublisher>();
export async function createTestProductionSpine(config: ProductionSpineConfig) {
  let evidence!: ProductionEvidencePublisher;
  let operator!: RiskMandateOperatorAuthority;
  const spine = await createSpine({ ...config,
    bindEvidencePublisher(value) { evidence = value; config.bindEvidencePublisher?.(value); },
    bindOperatorAuthority(value) { operator = value; config.bindOperatorAuthority?.(value); },
  });
  ports.set(spine, Object.freeze({ ...spine.kernel, publish: evidence.publish }));
  evidencePorts.set(spine, evidence);
  operators.set(spine, operator);
  return spine;
}
export function testSpinePublisher(spine: ProductionSpine) {
  const port = ports.get(spine);
  if (!port) throw new Error('TEST_SPINE_COMPOSITION_CAPABILITY_MISSING');
  return port;
}
export function testSpineOperator(spine: ProductionSpine) {
  const port = operators.get(spine);
  if (!port) throw new Error('TEST_OPERATOR_CAPABILITY_MISSING');
  return port;
}
export function testSpineEvidencePublisher(spine: ProductionSpine) {
  const port = evidencePorts.get(spine);
  if (!port) throw new Error('TEST_SPINE_COMPOSITION_CAPABILITY_MISSING');
  return port;
}
