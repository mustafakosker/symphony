import type { Task } from "../../shared/contracts";
import { ArtifactPreview } from "./ArtifactPreview";

export function TaskArtifacts({ task }: { task: Task }) {
  const seen = new Set<string>();
  const artifacts = task.artifacts.filter(artifact => {
    const identity = `${artifact.id}\0${artifact.version}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });

  return <section className="task-artifacts" aria-label="Saved output">
    <h3>Saved output</h3>
    {artifacts.length === 0
      ? <p>No saved output yet.</p>
      : <ul>{artifacts.map(artifact => <ArtifactPreview key={`${task.id}:${artifact.id}:${artifact.version}`}
        taskId={task.id} artifact={artifact} />)}</ul>}
  </section>;
}
