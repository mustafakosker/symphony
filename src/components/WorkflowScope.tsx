import type { Workflow } from "../../shared/contracts";

export default function WorkflowScope({ workflow }: { workflow: Workflow }) {
  return <>
    <p>Completion checks: {workflow.completionChecks.join(", ") || "none"}</p>
    <ol>{workflow.steps.map(step => <li key={step.id}>
      <strong>{step.title}</strong>
      {step.kind === "agent" ? <>
        <p>{step.instructions}</p><p>Role: {step.role}</p>
        <p>Permitted actions: {step.actions.join(", ") || "none"}</p>
        <p>Repositories: {step.repositories.join(", ") || "none"}</p>
        <p>Inputs: {step.inputs.map(ref => `${ref.id} v${ref.version} (${ref.digest})`).join(", ") || "none"}</p>
        <p>Outputs: {step.outputs.join(", ") || "none"}</p><p>Checks: {step.checks.join(", ") || "none"}</p>
      </> : <>
        <p>Review after {step.producerStepId}</p><p>Artifacts: {step.artifactIds.join(", ") || "all producer artifacts"}</p>
        <p>Allows next: {step.allowsStepId ?? "workflow completion"}</p>
      </>}
    </li>)}</ol>
  </>;
}
