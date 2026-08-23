import type { ReactNode } from "react";
import { generationErrorPresentation } from "./generationErrorPresentation";

type GenerationErrorStatusProps = {
  message: string | null | undefined;
  title?: string;
};

/** Result-pane failure — matches generating layout with a status line + details expander. */
export function GenerationErrorStatus({
  message,
  title = "Generation failed",
}: GenerationErrorStatusProps) {
  const presentation = generationErrorPresentation(message);
  if (!presentation) return null;

  return (
    <>
      <h3 className="generate-result-title">{title}</h3>
      <p
        className="generate-result-note generate-result-note--error"
        role="alert"
      >
        {presentation.summary}
      </p>
      <details className="generate-result-error-details">
        <summary>Technical details</summary>
        <pre className="generate-result-error-pre">{presentation.details}</pre>
      </details>
    </>
  );
}

type GenerateDualErrorActionsProps = {
  onDiscard?: () => void;
  onRetry?: () => void;
  discardLabel?: string;
  retryLabel?: string;
};

/** Form tab after failure — recovery actions only. */
export function GenerateDualErrorActions({
  onDiscard,
  onRetry,
  discardLabel = "Discard",
  retryLabel = "Try again",
}: GenerateDualErrorActionsProps) {
  if (!onDiscard && !onRetry) return null;

  return (
    <div className="generate-dual-error-actions">
      <p className="muted generate-dual-error-actions-lead">
        See Result for error details.
      </p>
      <div className="generate-dual-error-actions-row">
        {onRetry ? (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : null}
        {onDiscard ? (
          <button type="button" className="btn" onClick={onDiscard}>
            {discardLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** @deprecated Use {@link GenerationErrorStatus} in Result; form recovery uses footer buttons. */
export function GenerationErrorAlert({
  message,
  title = "Generation failed",
  actions = null,
  className = "",
}: {
  message: string | null | undefined;
  title?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <GenerationErrorStatus message={message} title={title} />
      {actions}
    </div>
  );
}
