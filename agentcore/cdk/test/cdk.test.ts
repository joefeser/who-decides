import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentCoreStack } from '../lib/cdk-stack';

const emptySpec = {
  name: 'testproject',
  version: 1,
  managedBy: 'CDK' as const,
  runtimes: [],
  memories: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  configBundles: [],
  policyEngines: [],
  payments: [],
  agentCoreGateways: [],
  mcpRuntimeTools: [],
  unassignedTargets: [],
  datasets: [],
  knowledgeBases: [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const containerRuntime = (name: string): any => ({
  name,
  build: 'Container',
  entrypoint: 'main.js',
  codeLocation: 'agentcore/app/who-decides-agent',
  runtimeVersion: 'NODE_22',
  protocol: 'HTTP',
  networkMode: 'PUBLIC',
  buildContextPath: '.',
  dockerfile: 'Dockerfile',
});

function synthesize(runtimes: ReturnType<typeof containerRuntime>[]) {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestStack', {
    spec: { ...emptySpec, runtimes },
  });
  return Template.fromStack(stack);
}

test('AgentCoreStack synthesizes with empty spec', () => {
  const template = synthesize([]);
  template.hasOutput('StackNameOutput', {
    Description: 'Name of the CloudFormation Stack',
  });
});

test('runtime artifact-type replacement derives stable logical ids from runtime names', () => {
  // Insertion/reordering must not remap replacement ids onto the wrong
  // runtime: the id comes from the runtime's configured name.
  const single = synthesize([containerRuntime('alpha_agent')]);
  const both = synthesize([containerRuntime('alpha_agent'), containerRuntime('beta_agent')]);

  const alphaId = Object.keys(single.findResources('AWS::BedrockAgentCore::Runtime'))[0];
  const bothIds = Object.keys(both.findResources('AWS::BedrockAgentCore::Runtime'));
  expect(alphaId).toMatch(/^AgentRuntime.+Container$/);
  expect(bothIds).toContain(alphaId);
  expect(bothIds).toHaveLength(2);
  expect(new Set(bothIds).size).toBe(2);
});

test('runtime artifact-type replacement gives the new runtime a distinct physical name', () => {
  // CloudFormation creates additions before deletions: the replacement must
  // not reuse the old runtime's still-existing agentRuntimeName.
  const template = synthesize([containerRuntime('who_decides_agent')]);
  const [logicalId, resource] = Object.entries(
    template.findResources('AWS::BedrockAgentCore::Runtime'),
  )[0]!;
  expect(logicalId).toBe('AgentRuntimetestprojectwhodecidesagentContainer');
  expect(resource.Properties.AgentRuntimeName).toBe('testproject_who_decides_agent_container');
});
