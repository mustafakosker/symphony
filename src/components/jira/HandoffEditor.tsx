import type { Target, TargetOption } from "../../../shared/jira-preparation";
export default function HandoffEditor({
  promptText,
  target,
  targets,
  disabled,
  dirty,
  busy,
  loading = false,
  onPrompt,
  onTarget,
  onSave,
}: {
  promptText: string;
  target: Target | null;
  targets: TargetOption[];
  disabled: boolean;
  dirty: boolean;
  busy: boolean;
  loading?: boolean;
  onPrompt: (value: string) => void;
  onTarget: (value: Target | null) => void;
  onSave: () => void;
}) {
  return (
    <section className="jira-editor" aria-label="Launch instructions">
      <div className="jira-section-heading">
        <h3>Launch instructions</h3>
        <span role="status">
          {loading
            ? "Loading saved draft…"
            : busy
              ? "Saving or sending…"
              : dirty
                ? "Unsaved changes"
                : "Draft saved"}
        </span>
      </div>
      <p>Review the prompt and target before sending your documents to ONA.</p>
      <div className="jira-target-fields">
        <label>
          Repository
          <select
            aria-label="Repository"
            disabled={disabled}
            value={target ? `${target.projectId}/${target.repositoryId}` : ""}
            onChange={(event) => {
              const option = targets.find(
                (o) =>
                  `${o.projectId}/${o.repositoryId}` === event.target.value,
              );
              onTarget(
                option
                  ? {
                      projectId: option.projectId,
                      repositoryId: option.repositoryId,
                      branch: option.baseBranch,
                    }
                  : null,
              );
            }}
          >
            <option value="">Select a repository</option>
            {targets.map((option) => (
              <option
                key={`${option.projectId}/${option.repositoryId}`}
                value={`${option.projectId}/${option.repositoryId}`}
              >
                {option.projectId} / {option.repositoryId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Branch
          <input
            aria-label="Branch"
            disabled={disabled || !target}
            value={target?.branch ?? ""}
            maxLength={255}
            onChange={(event) => {
              if (target) onTarget({ ...target, branch: event.target.value });
            }}
          />
        </label>
      </div>
      <label>
        Launch prompt
        <textarea
          aria-label="Launch prompt"
          disabled={disabled}
          value={promptText}
          onChange={(event) => onPrompt(event.target.value)}
          rows={11}
        />
      </label>
      <button
        className="button secondary"
        disabled={disabled || busy || !dirty}
        onClick={onSave}
      >
        Save draft
      </button>
    </section>
  );
}
